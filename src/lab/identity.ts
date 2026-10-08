import { Array, Equal, Hash, Option, Predicate, pipe } from 'effect'

// IDENTITY

export type Identity = Readonly<{
  of: (value: unknown) => unknown
  size: () => number
}>

type Entries = ReadonlyArray<readonly [string, unknown]>

const isReference = (value: unknown): value is object =>
  Predicate.isObject(value) || Array.isArray(value)

const isStructural = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return (
    Array.isArray(value) || prototype === Object.prototype || prototype === null
  )
}

const isSameEntries = (left: Entries, right: Entries): boolean =>
  left.length === right.length &&
  Array.every(left, ([key, child], index) => {
    const entry = right[index]
    return entry !== undefined && entry[0] === key && entry[1] === child
  })

// NOTE: `of` hash-conses. Equal values share one canonical reference and a
// value seen before resolves in O(1). Identifying an updated Model therefore
// visits only the objects update replaced, each at its own width.
export const makeIdentity = (): Identity => {
  const canonicalOf = new WeakMap<object, object>()
  const entriesOf = new WeakMap<object, Entries>()
  const hashOf = new WeakMap<object, number>()
  const buckets = new Map<number, ReadonlyArray<object>>()

  const hashKey = (key: unknown): number =>
    isReference(key) ? (hashOf.get(key) ?? Hash.random(key)) : Hash.hash(key)

  const hashEntries = (entries: Entries): number =>
    Array.reduce(entries, Hash.number(entries.length), (hash, [key, child]) =>
      pipe(hash, Hash.combine(Hash.string(key)), Hash.combine(hashKey(child))),
    )

  const isEquivalent = (
    candidate: object,
    value: object,
    maybeEntries: Option.Option<Entries>,
  ): boolean =>
    Object.getPrototypeOf(candidate) === Object.getPrototypeOf(value) &&
    Option.match(maybeEntries, {
      onNone: () =>
        Equal.isEqual(value)
          ? Equal.equals(candidate, value)
          : candidate === value,
      onSome: entries => isSameEntries(entries, entriesOf.get(candidate) ?? []),
    })

  const remember = (
    value: object,
    hash: number,
    maybeEntries: Option.Option<Entries>,
  ): object => {
    canonicalOf.set(value, value)
    hashOf.set(value, hash)
    if (Option.isSome(maybeEntries)) {
      entriesOf.set(value, maybeEntries.value)
    }
    buckets.set(hash, Array.append(buckets.get(hash) ?? [], value))
    return value
  }

  const of = (value: unknown): unknown => {
    if (!isReference(value)) {
      return value
    }
    const known = canonicalOf.get(value)
    if (known !== undefined) {
      return known
    }
    const maybeEntries = isStructural(value)
      ? Option.some(
          Array.map(
            Object.entries(value),
            ([key, child]): readonly [string, unknown] => [key, of(child)],
          ),
        )
      : Option.none()
    const hash = Option.match(maybeEntries, {
      onNone: () =>
        Equal.isEqual(value) ? Hash.hash(value) : Hash.random(value),
      onSome: hashEntries,
    })
    return Option.match(
      Array.findFirst(buckets.get(hash) ?? [], candidate =>
        isEquivalent(candidate, value, maybeEntries),
      ),
      {
        onNone: () => remember(value, hash, maybeEntries),
        onSome: candidate => {
          canonicalOf.set(value, candidate)
          return candidate
        },
      },
    )
  }

  const size = () =>
    Array.reduce(buckets.values(), 0, (total, bucket) => total + bucket.length)

  return { of, size }
}
