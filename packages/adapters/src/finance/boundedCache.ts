/**
 * A small in-process cache bounded by entry count and, optionally, by age
 * (ADR-0039). The caller passes the injected clock's time, so tests are
 * deterministic and nothing reads wall time here. Twin of the Rust
 * `research_finance::bounded_cache`.
 */
export interface BoundedCache<K, V> {
	/** The fresh value, marked most recently used; a stale entry is removed. */
	get(key: K, nowMs: number): V | undefined;
	/** Stores the value as most recently used, evicting the least recently used beyond the capacity. */
	set(key: K, value: V, nowMs: number): void;
	/** Entries currently held, stale ones included. */
	readonly size: number;
}

/**
 * `ttlMs` null keeps entries until evicted, for data that never changes. A
 * zero capacity stores nothing.
 */
export function createBoundedCache<K, V>(
	capacity: number,
	ttlMs: number | null,
): BoundedCache<K, V> {
	// A Map iterates in insertion order: the first key is the least recently used.
	const entries = new Map<K, { readonly storedAtMs: number; readonly value: V }>();
	return {
		get(key, nowMs) {
			const entry = entries.get(key);
			if (entry === undefined) return undefined;
			// A clock that moved backwards past the stamp also counts as stale.
			const fresh =
				ttlMs === null || (nowMs >= entry.storedAtMs && nowMs - entry.storedAtMs < ttlMs);
			entries.delete(key);
			if (!fresh) return undefined;
			entries.set(key, entry);
			return entry.value;
		},
		set(key, value, nowMs) {
			if (capacity <= 0) return;
			entries.delete(key);
			for (const oldest of entries.keys()) {
				if (entries.size < capacity) break;
				entries.delete(oldest);
			}
			entries.set(key, { storedAtMs: nowMs, value });
		},
		get size() {
			return entries.size;
		},
	};
}
