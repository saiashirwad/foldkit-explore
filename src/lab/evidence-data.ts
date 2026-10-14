import { Array, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { dataPath, dataShape, unsupportedData } from './execution-data'
import { ReplayDivergenceError } from './replay'

type NestedData =
  | Readonly<{ _tag: 'Undefined' }>
  | Readonly<{ _tag: 'Null' }>
  | Readonly<{ _tag: 'None' }>
  | Readonly<{ _tag: 'Boolean'; value: boolean }>
  | Readonly<{ _tag: 'String'; value: string }>
  | Readonly<{ _tag: 'Number'; value: string }>
  | Readonly<{ _tag: 'BigInt'; value: string }>
  | Readonly<{ _tag: 'Some'; enumerable: boolean; value: NestedData }>
  | Readonly<{
      _tag: 'Array'
      items: ReadonlyArray<Readonly<{ enumerable: boolean; value: NestedData }>>
    }>
  | Readonly<{
      _tag: 'Record'
      prototype: 'plain' | 'null'
      properties: ReadonlyArray<
        Readonly<{
          key: string
          enumerable: boolean
          value: NestedData
        }>
      >
    }>

const nestedData: Schema.Codec<NestedData> = Schema.suspend(() => EvidenceData)
export const EvidenceData = defineTaggedUnion({
  Undefined: {},
  Null: {},
  None: {},
  Boolean: { value: Schema.Boolean },
  String: { value: Schema.String },
  Number: { value: Schema.String },
  BigInt: { value: Schema.String },
  Some: { enumerable: Schema.Boolean, value: nestedData },
  Array: {
    items: Schema.Array(
      Schema.Struct({ enumerable: Schema.Boolean, value: nestedData }),
    ),
  },
  Record: {
    prototype: Schema.Literals(['plain', 'null']),
    properties: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        enumerable: Schema.Boolean,
        value: nestedData,
      }),
    ),
  },
})
export type EvidenceData = typeof EvidenceData.Type

// NOTE: JSON is only the outer transport. Tagged values retain undefined, Option,
// non-finite numbers, signed zero, record order/prototype and own enumerability.
export const encodeEvidenceData = (
  value: unknown,
  path = '$',
): EvidenceData => {
  const ancestors = new Set<object>()
  const encode = (current: unknown, currentPath: string): EvidenceData => {
    if (current === undefined) {
      return EvidenceData.Undefined()
    }
    if (current === null) {
      return EvidenceData.Null()
    }
    if (typeof current === 'boolean') {
      return EvidenceData.Boolean({ value: current })
    }
    if (typeof current === 'string') {
      return EvidenceData.String({ value: current })
    }
    if (typeof current === 'number') {
      return EvidenceData.Number({
        value: Object.is(current, -0) ? '-0' : String(current),
      })
    }
    if (typeof current === 'bigint') {
      return EvidenceData.BigInt({ value: String(current) })
    }
    if (typeof current !== 'object') {
      return unsupportedData('canonicalize', currentPath, typeof current)
    }
    if (ancestors.has(current)) {
      return unsupportedData('canonicalize', currentPath, 'a cyclic value')
    }
    ancestors.add(current)
    try {
      const shape = dataShape(current, currentPath, 'canonicalize')
      if (shape.kind === 'none') {
        return EvidenceData.None()
      }
      if (shape.kind === 'some') {
        const property = Option.getOrThrow(Array.head(shape.properties))
        return EvidenceData.Some({
          enumerable: property.enumerable,
          value: encode(property.value, dataPath(currentPath, 'value')),
        })
      }
      if (shape.kind === 'array') {
        return EvidenceData.Array({
          items: Array.map(
            Array.filter(shape.properties, ({ key }) => key !== 'length'),
            ({ key, value: child, enumerable }) => ({
              enumerable,
              value: encode(child, dataPath(currentPath, key)),
            }),
          ),
        })
      }
      return EvidenceData.Record({
        prototype: Object.getPrototypeOf(current) === null ? 'null' : 'plain',
        properties: Array.map(
          shape.properties,
          ({ key, value: child, enumerable }) => ({
            key,
            enumerable,
            value: encode(child, dataPath(currentPath, key)),
          }),
        ),
      })
    } finally {
      ancestors.delete(current)
    }
  }
  return encode(value, path)
}

export const decodeEvidenceData = (value: EvidenceData): unknown => {
  const decode = (current: NestedData): unknown => {
    return EvidenceData.match<unknown>(current, {
      Undefined: () => undefined,
      Null: () => null,
      None: () => Option.none(),
      Boolean: ({ value }) => value,
      String: ({ value }) => value,
      Number: ({ value }) => {
        const number = Number(value)
        if ((Object.is(number, -0) ? '-0' : String(number)) !== value) {
          throw new ReplayDivergenceError(
            'artifact',
            'Evidence contains an invalid number token.',
          )
        }
        return number
      },
      BigInt: ({ value }) => {
        try {
          const bigint = BigInt(value)
          if (String(bigint) !== value) {
            throw new Error('Noncanonical bigint token.')
          }
          return bigint
        } catch (cause) {
          throw new ReplayDivergenceError(
            'artifact',
            'Evidence contains an invalid bigint token.',
            { cause },
          )
        }
      },
      Some: ({ enumerable, value }) => {
        const maybeValue = Option.some(decode(value))
        Object.defineProperty(maybeValue, 'value', { enumerable })
        return maybeValue
      },
      Array: ({ items }) => {
        const array = Array.map(items, item => decode(item.value))
        Array.forEach(items, ({ enumerable }, index) => {
          Object.defineProperty(array, String(index), { enumerable })
        })
        return array
      },
      Record: ({ prototype, properties }) => {
        const record: Record<string, unknown> = {}
        if (prototype === 'null') {
          Object.setPrototypeOf(record, null)
        }
        Array.forEach(properties, ({ key, enumerable, value }) => {
          if (Object.hasOwn(record, key)) {
            throw new ReplayDivergenceError(
              'artifact',
              'Evidence contains a repeated record property.',
            )
          }
          Object.defineProperty(record, key, {
            value: decode(value),
            enumerable,
            writable: true,
            configurable: true,
          })
        })
        return record
      },
    })
  }
  return decode(Schema.decodeUnknownSync(EvidenceData)(value))
}
