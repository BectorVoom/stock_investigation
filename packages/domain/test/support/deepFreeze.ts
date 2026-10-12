/**
 * Recursively freezes a value so that any in-place mutation by the code under
 * test throws (ES modules are strict mode) instead of going unnoticed.
 */
export function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Reflect.ownKeys(value)) {
		deepFreeze(Reflect.get(value, key));
	}
	return value;
}
