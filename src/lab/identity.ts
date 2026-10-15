import { Array, Hash, Predicate, pipe } from 'effect'

import { dataPath, dataShape, unsupportedData } from './execution-data'

// IDENTITY

type Identity = Readonly<{
  of: (value: unknown, path?: string) => unknown
  size: () => number
  clear: () => void
}>

type Entries = ReadonlyArray<readonly [string, unknown, boolean]>

const isReference = (value: unknown): value is object =>
  Predicate.isObject(value) || Array.isArray(value)

export const isStructural = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return (
    Array.isArray(value) || prototype === Object.prototype || prototype === null
  )
}

const isSameEntries = (left: Entries, right: Entries): boolean =>
  left.length === right.length &&
  Array.every(left, ([key, child, enumerable], index) => {
    const entry = right[index]
    return (
      entry !== undefined &&
      entry[0] === key &&
      Object.is(entry[1], child) &&
      entry[2] === enumerable
    )
  })

export const makeIdentity = (): Identity => {
  const negativeZero = Symbol('-0')
  const canonicalOf = new WeakMap<object, object>()
  const entriesOf = new WeakMap<object, Entries>()
  const hashOf = new WeakMap<object, number>()
  const buckets = new Map<number, ReadonlyArray<object>>()
  const ancestors = new Set<object>()

  const hashKey = (key: unknown): number =>
    isReference(key) ? (hashOf.get(key) ?? Hash.random(key)) : Hash.hash(key)

  const hashEntries = (entries: Entries): number =>
    Array.reduce(
      entries,
      Hash.number(entries.length),
      (hash, [key, child, enumerable]) =>
        pipe(
          hash,
          Hash.combine(Hash.string(key)),
          Hash.combine(hashKey(child)),
          Hash.combine(Hash.hash(enumerable)),
        ),
    )

  const remember = (value: object, hash: number, entries: Entries): object => {
    canonicalOf.set(value, value)
    hashOf.set(value, hash)
    entriesOf.set(value, entries)
    buckets.set(hash, Array.append(buckets.get(hash) ?? [], value))
    return value
  }

  const of = (value: unknown, path = '$'): unknown => {
    if (!isReference(value)) {
      if (typeof value === 'function' || typeof value === 'symbol') {
        return unsupportedData('identify', path, typeof value)
      }
      // NOTE: Map keys collapse 0 and -0, so -0 needs a distinct identity token.
      return Object.is(value, -0) ? negativeZero : value
    }
    const known = canonicalOf.get(value)
    if (known !== undefined) {
      return known
    }
    if (ancestors.has(value)) {
      return unsupportedData('identify', path, 'a cyclic value')
    }
    ancestors.add(value)
    try {
      const shape = dataShape(value, path, 'identify')
      const entries = Array.map(
        shape.properties,
        ({
          key,
          value: child,
          enumerable,
        }): readonly [string, unknown, boolean] => [
          key,
          of(child, dataPath(path, key)),
          enumerable,
        ],
      )
      const hash = hashEntries(entries)
      const candidate = (buckets.get(hash) ?? []).find(
        candidate =>
          Object.getPrototypeOf(candidate) === Object.getPrototypeOf(value) &&
          isSameEntries(entries, entriesOf.get(candidate) ?? []),
      )
      // NOTE: Deep freezing makes the reference cache safe without rescanning shared data.
      Object.freeze(value)
      if (candidate === undefined) {
        return remember(value, hash, entries)
      }
      canonicalOf.set(value, candidate)
      return candidate
    } finally {
      ancestors.delete(value)
    }
  }

  const size = () =>
    Array.reduce(buckets.values(), 0, (total, bucket) => total + bucket.length)

  return {
    of,
    size,
    clear: () => {
      buckets.clear()
      ancestors.clear()
    },
  }
}
