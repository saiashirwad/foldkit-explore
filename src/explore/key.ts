import { Array, Order } from 'effect'

// A stable text key for plain data: object keys are sorted so property order
// never matters. Functions and symbols do not belong in a Model.
export const keyOf = (value: unknown): string => {
  if (value === undefined) {
    return 'undefined'
  }
  if (typeof value === 'bigint') {
    return `${value}n`
  }
  if (typeof value === 'number' && Object.is(value, -0)) {
    return '-0'
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`Cannot key a ${typeof value}; keep Models plain data.`)
  }
  if (Array.isArray(value)) {
    return `[${Array.map(value, keyOf).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Array.map(
      Array.sort(Object.keys(value), Order.String),
      name => `${JSON.stringify(name)}:${keyOf(Reflect.get(value, name))}`,
    )
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
