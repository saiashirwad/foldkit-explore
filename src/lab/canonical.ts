import { Array, Order } from 'effect'

import {
  type DataProperty,
  dataPath,
  dataProperties,
  dataShape,
  unsupportedData,
} from './execution-data'

// Use the same own-data property domain for canonical keys and content deltas.
export const ownDataEntries = (
  value: object,
): ReadonlyArray<readonly [string, unknown]> =>
  Array.map(
    dataProperties(value, '$', 'canonicalize'),
    ({ key, value: child }): readonly [string, unknown] => [key, child],
  )

// NOTE: This is a matching key, not JSON. Explicit tokens preserve values JSON
// would omit or collapse; Option instances keep their public Some/None meaning.
export const canonical = (value: unknown): string => {
  const ancestors = new Set<object>()
  const encode = (current: unknown, path: string): string => {
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
      return unsupportedData('canonicalize', path, typeof current)
    }
    if (ancestors.has(current)) {
      return unsupportedData('canonicalize', path, 'a cyclic value')
    }
    ancestors.add(current)
    try {
      const shape = dataShape(current, path, 'canonicalize')
      if (shape.kind === 'none') {
        return 'Option.none'
      }
      if (shape.kind === 'some') {
        return `Option.some(${encode(shape.properties[0]?.value, dataPath(path, 'value'))})`
      }
      if (shape.kind === 'array') {
        return `[${Array.map(
          Array.filter(shape.properties, ({ key }) => key !== 'length'),
          ({ key, value: child }) => encode(child, dataPath(path, key)),
        ).join(',')}]`
      }
      return `{${Array.map(
        Array.sort(
          shape.properties,
          Order.mapInput(
            Order.String,
            (property: DataProperty) => property.key,
          ),
        ),
        ({ key, value: child }) =>
          `${JSON.stringify(key)}:${encode(child, dataPath(path, key))}`,
      ).join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }
  return encode(value, '$')
}
