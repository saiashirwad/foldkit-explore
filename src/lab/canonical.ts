import { Array, Option, Order } from 'effect'

const propertyValue = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(
      `Cannot canonicalize an accessor property ${JSON.stringify(key)}.`,
    )
  }
  return descriptor.value
}

// NOTE: This is a matching key, not JSON. Explicit tokens preserve values JSON
// would omit or collapse; Option instances keep their public Some/None meaning.
export const canonical = (value: unknown): string => {
  const ancestors = new Set<object>()
  const encode = (current: unknown): string => {
    if (current === null) {
      return 'null'
    }
    if (current === undefined) {
      return 'undefined'
    }
    if (typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current)
    }
    if (typeof current === 'number') {
      return Object.is(current, -0) ? '-0' : String(current)
    }
    if (typeof current === 'bigint') {
      return `${current}n`
    }
    if (typeof current !== 'object') {
      throw new Error(
        `Cannot canonicalize ${typeof current}; provide a data encoding.`,
      )
    }
    if (ancestors.has(current)) {
      throw new Error('Cannot canonicalize a cyclic value.')
    }
    ancestors.add(current)
    try {
      if (Option.isOption(current)) {
        return Option.match(current, {
          onNone: () => 'Option.none',
          onSome: child => `Option.some(${encode(child)})`,
        })
      }
      if (Array.isArrayNonEmpty(Object.getOwnPropertySymbols(current))) {
        throw new Error(
          'Cannot canonicalize symbol properties; provide a data encoding.',
        )
      }
      const keys = Object.getOwnPropertyNames(current)
      if (Array.isArray(current)) {
        const indices = Array.filter(keys, key => key !== 'length')
        if (
          indices.length !== current.length ||
          !Array.every(indices, (key, index) => key === String(index))
        ) {
          throw new Error(
            'Cannot canonicalize sparse arrays or arrays with extra properties.',
          )
        }
        return `[${Array.map(indices, key => encode(propertyValue(current, key))).join(',')}]`
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(
          'Cannot canonicalize an object with a custom prototype; provide a data encoding.',
        )
      }
      return `{${Array.map(
        Array.sort(keys, Order.String),
        key => `${JSON.stringify(key)}:${encode(propertyValue(current, key))}`,
      ).join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }
  return encode(value)
}
