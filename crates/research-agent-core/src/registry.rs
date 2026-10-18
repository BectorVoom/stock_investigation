//! Insertion-ordered backend registration (FR-013, ARCH-006).

use crate::runtime::{AgentProbe, AgentRuntime};
use futures_util::{FutureExt, future::join_all};
use research_contracts::agent::{
	AgentAvailability, AgentCapabilities, AgentDescriptor, UnavailableReason,
};
use std::{collections::HashMap, panic::AssertUnwindSafe, sync::Arc};

/// An id was registered twice.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("duplicate agent id \"{0}\"")]
pub struct DuplicateAgentId(pub String);

/// Copies the registration list and preserves its order for probes and discovery.
pub struct AgentRegistry {
	runtimes: Vec<Arc<dyn AgentRuntime>>,
	by_id: HashMap<String, usize>,
}

impl AgentRegistry {
	/// Builds the registry, refusing duplicate ids before any probes run.
	pub fn new(runtimes: Vec<Arc<dyn AgentRuntime>>) -> Result<Self, DuplicateAgentId> {
		let mut by_id = HashMap::with_capacity(runtimes.len());
		for (index, runtime) in runtimes.iter().enumerate() {
			if by_id.insert(runtime.agent_id().to_owned(), index).is_some() {
				return Err(DuplicateAgentId(runtime.agent_id().to_owned()));
			}
		}
		Ok(Self { runtimes, by_id })
	}

	/// Finds a backend without probing it.
	pub fn get(&self, id: &str) -> Option<&Arc<dyn AgentRuntime>> {
		self.by_id
			.get(id)
			.and_then(|index| self.runtimes.get(*index))
	}

	/// Ids in registration order.
	pub fn ids(&self) -> Vec<&str> {
		self.runtimes
			.iter()
			.map(|runtime| runtime.agent_id())
			.collect()
	}

	/// Probes concurrently; one panicking backend cannot hide its neighbours.
	pub async fn describe_all(&self) -> Vec<AgentDescriptor> {
		join_all(self.runtimes.iter().map(|runtime| async move {
			let probe = AssertUnwindSafe(async { runtime.probe().await })
				.catch_unwind()
				.await
				.unwrap_or_else(|_| AgentProbe {
					capabilities: AgentCapabilities {
						supported: vec![],
						model: None,
						models: None,
					},
					availability: AgentAvailability::Unavailable {
						reason_code: UnavailableReason::ProbeFailed,
						// A Rust panic payload is not a JavaScript Error; never expose its message.
						detail: "probe threw".to_owned(),
					},
				});
			AgentDescriptor {
				agent_id: runtime.agent_id().to_owned(),
				display_name: runtime.display_name().to_owned(),
				capabilities: probe.capabilities,
				availability: probe.availability,
				cost_model: runtime.cost_model(),
				tool_isolation: runtime.tool_isolation(),
			}
		}))
		.await
	}
}
