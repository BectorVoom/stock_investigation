//! A small in-process cache bounded by entry count and, optionally, by age
//! (ADR-0039). The caller passes the injected clock's time, so tests are
//! deterministic and nothing reads wall time here.
use indexmap::IndexMap;
use std::{borrow::Borrow, hash::Hash, sync::Mutex};

/// Least-recently-used entries are evicted first once `capacity` is reached.
/// The lock is only held for the map operation, never across an await.
pub struct BoundedCache<K, V> {
	capacity: usize,
	/// Entries older than this are misses (and are dropped); `None` keeps
	/// them until evicted, for data that never changes.
	ttl_ms: Option<i64>,
	/// Insertion order is recency order: the first entry is the least recently used.
	entries: Mutex<IndexMap<K, (i64, V)>>,
}

impl<K: Hash + Eq, V: Clone> BoundedCache<K, V> {
	/// An empty cache; a zero capacity never stores anything.
	pub fn new(capacity: usize, ttl_ms: Option<i64>) -> Self {
		Self {
			capacity,
			ttl_ms,
			entries: Mutex::new(IndexMap::new()),
		}
	}

	/// The fresh value for `key`, marked most recently used. A stale entry is
	/// removed. A poisoned lock reads as a miss: the cache only saves requests.
	pub fn get<Q>(&self, key: &Q, now_ms: i64) -> Option<V>
	where
		K: Borrow<Q>,
		Q: Hash + Eq + ?Sized,
	{
		let mut entries = self.entries.lock().ok()?;
		let index = entries.get_index_of(key)?;
		let stored_at = entries.get_index(index).map(|(_, (at, _))| *at)?;
		// A clock that moved backwards past the stamp also counts as stale.
		let fresh = self
			.ttl_ms
			.is_none_or(|ttl| now_ms >= stored_at && now_ms - stored_at < ttl);
		if !fresh {
			entries.shift_remove_index(index);
			return None;
		}
		let last = entries.len() - 1;
		entries.move_index(index, last);
		entries.get_index(last).map(|(_, (_, value))| value.clone())
	}

	/// Stores `value` as the most recently used entry, stamped `now_ms`,
	/// evicting the least recently used ones beyond the capacity.
	pub fn insert(&self, key: K, value: V, now_ms: i64) {
		if self.capacity == 0 {
			return;
		}
		let Ok(mut entries) = self.entries.lock() else {
			return;
		};
		entries.shift_remove(&key);
		while entries.len() >= self.capacity {
			entries.shift_remove_index(0);
		}
		entries.insert(key, (now_ms, value));
	}

	/// Entries currently held, stale ones included.
	pub fn len(&self) -> usize {
		self.entries.lock().map_or(0, |entries| entries.len())
	}

	/// True when nothing is held.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn evicts_the_least_recently_used_entry_first() {
		let cache = BoundedCache::new(2, None);
		cache.insert("a", 1, 0);
		cache.insert("b", 2, 0);
		assert_eq!(cache.get(&"a", 0), Some(1));
		cache.insert("c", 3, 0);
		assert_eq!(cache.len(), 2);
		assert_eq!(cache.get(&"b", 0), None);
		assert_eq!(cache.get(&"a", 0), Some(1));
		assert_eq!(cache.get(&"c", 0), Some(3));
	}

	#[test]
	fn an_entry_expires_after_its_ttl() {
		let cache = BoundedCache::new(4, Some(100));
		cache.insert("a", 1, 1_000);
		assert_eq!(cache.get(&"a", 1_099), Some(1));
		assert_eq!(cache.get(&"a", 1_100), None);
		assert!(cache.is_empty());
		cache.insert("b", 2, 1_000);
		assert_eq!(cache.get(&"b", 999), None, "a clock moved backwards");
	}

	#[test]
	fn reinserting_a_key_replaces_it_without_growing() {
		let cache = BoundedCache::new(2, Some(100));
		cache.insert("a", 1, 0);
		cache.insert("a", 2, 50);
		assert_eq!(cache.len(), 1);
		assert_eq!(cache.get(&"a", 140), Some(2));
	}

	#[test]
	fn a_zero_capacity_stores_nothing() {
		let cache = BoundedCache::new(0, None);
		cache.insert("a", 1, 0);
		assert_eq!(cache.get(&"a", 0), None);
	}
}
