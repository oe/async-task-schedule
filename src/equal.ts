/** Structural comparison for plain objects/arrays; opaque objects use identity. */
export function isEqual(a: unknown, b: unknown, ancestors = new WeakMap<object, object>()): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && String(a) === String(b)
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && isEqual(a.getTime(), b.getTime())
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false
  const prototypeA = Object.getPrototypeOf(a)
  const prototypeB = Object.getPrototypeOf(b)
  if (prototypeA !== prototypeB) return false
  if (!Array.isArray(a) && prototypeA !== Object.prototype && prototypeA !== null) return false
  const paired = ancestors.get(a)
  if (paired) return paired === b
  const keysA = Reflect.ownKeys(a).filter(key => Object.prototype.propertyIsEnumerable.call(a, key))
  const keysB = Reflect.ownKeys(b).filter(key => Object.prototype.propertyIsEnumerable.call(b, key))
  if (keysA.length !== keysB.length) return false
  ancestors.set(a, b)
  const equal = keysA.every(key => Object.prototype.hasOwnProperty.call(b, key)
    && isEqual((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key], ancestors))
  ancestors.delete(a)
  return equal
}
