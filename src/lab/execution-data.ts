import { Array, Option } from 'effect'

export type DataProperty = Readonly<{
  key: string
  value: unknown
  enumerable: boolean
}>

type Purpose = 'identify' | 'canonicalize'

const somePrototype = Object.getPrototypeOf(Option.some(undefined))
const nonePrototype = Object.getPrototypeOf(Option.none())

export const dataPath = (path: string, key: string): string =>
  `${path}[${JSON.stringify(key)}]`

// JSON would collapse signed zero into zero; the explicit token keeps the two
// distinguishable in canonical keys and in evidence payloads.
export const numberToken = (value: number): string =>
  Object.is(value, -0) ? '-0' : String(value)

export const unsupportedData = (
  purpose: Purpose,
  path: string,
  reason: string,
): never => {
  throw new Error(`Cannot ${purpose} ${reason} at ${path}.`)
}

export const dataProperties = (
  value: object,
  path: string,
  purpose: Purpose,
): ReadonlyArray<DataProperty> => {
  if (Array.isArrayNonEmpty(Object.getOwnPropertySymbols(value))) {
    return unsupportedData(purpose, path, 'symbol properties')
  }
  return Array.map(Object.getOwnPropertyNames(value), key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return unsupportedData(
        purpose,
        dataPath(path, key),
        'an accessor property',
      )
    }
    return {
      key,
      value: descriptor.value,
      enumerable: descriptor.enumerable === true,
    }
  })
}

export const dataShape = (
  value: object,
  path: string,
  purpose: Purpose,
): Readonly<{
  kind: 'record' | 'array' | 'some' | 'none'
  properties: ReadonlyArray<DataProperty>
}> => {
  const properties = dataProperties(value, path, purpose)
  const prototype = Object.getPrototypeOf(value)
  if (prototype === somePrototype || prototype === nonePrototype) {
    const some = prototype === somePrototype
    if (
      some
        ? properties.length !== 1 || properties[0]?.key !== 'value'
        : Array.isReadonlyArrayNonEmpty(properties)
    ) {
      return unsupportedData(purpose, path, 'an Option with extra properties')
    }
    return { kind: some ? 'some' : 'none', properties }
  }
  if (Array.isArray(value)) {
    const indices = Array.filter(properties, ({ key }) => key !== 'length')
    if (
      prototype !== globalThis.Array.prototype ||
      indices.length !== value.length ||
      !Array.every(indices, ({ key }, index) => key === String(index))
    ) {
      return unsupportedData(
        purpose,
        path,
        'sparse arrays or arrays with extra properties or a custom prototype',
      )
    }
    return { kind: 'array', properties }
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return unsupportedData(purpose, path, 'an object with a custom prototype')
  }
  return { kind: 'record', properties }
}
