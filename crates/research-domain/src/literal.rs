//! String-literal unions (`"a" | "b"` in TypeScript) as Rust enums.
//!
//! The domain is the ONE definition of every literal union the wire contract
//! also names (ARCH-013): `research-contracts` decodes these enums with zod
//! semantics from [`VALUES`](crate::finance::types::Market::VALUES) and
//! [`ALL`](crate::finance::types::Market::ALL) instead of defining its own
//! copies. Declaration order is the TypeScript (zod enum) order, which zod's
//! "expected one of" messages depend on.

/// Defines a literal-union enum: `VALUES`, `ALL`, `as_str`,
/// `from_str_value`, `Display`, and serde as the literal string.
macro_rules! js_literal_enum {
	(
		$(#[$meta:meta])*
		$vis:vis enum $name:ident {
			$($(#[$vmeta:meta])* $variant:ident = $value:literal),+ $(,)?
		}
	) => {
		$(#[$meta])*
		#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
		$vis enum $name {
			$($(#[$vmeta])* $variant),+
		}

		impl $name {
			/// The TypeScript literals, in declaration order.
			pub const VALUES: &'static [&'static str] = &[$($value),+];
			/// Every variant, in the order of `VALUES`.
			pub const ALL: &'static [Self] = &[$(Self::$variant),+];

			/// The TypeScript literal.
			#[must_use]
			pub const fn as_str(self) -> &'static str {
				match self {
					$(Self::$variant => $value),+
				}
			}

			/// The variant whose literal is `value`, if any.
			#[must_use]
			pub fn from_str_value(value: &str) -> Option<Self> {
				Self::ALL.iter().copied().find(|variant| variant.as_str() == value)
			}
		}

		impl std::fmt::Display for $name {
			fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
				formatter.write_str(self.as_str())
			}
		}

		impl serde::Serialize for $name {
			fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
				serializer.serialize_str(self.as_str())
			}
		}

		impl<'de> serde::Deserialize<'de> for $name {
			fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
				let value = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
				Self::from_str_value(&value)
					.ok_or_else(|| serde::de::Error::unknown_variant(&value, Self::VALUES))
			}
		}
	};
}

pub(crate) use js_literal_enum;
