import { Array, Equal, Hash, Option } from 'effect'
import { expect, test, vi } from 'vitest'

import { canonical } from './canonical'
import { makeIdentity } from './identity'

test('equal values share one identity', () => {
  const identity = makeIdentity()
  expect(identity.of({ zip: '', tags: ['a'] })).toBe(
    identity.of({ zip: '', tags: ['a'] }),
  )
  expect(identity.of({ zip: '' })).not.toBe(identity.of({ zip: '90210' }))
})

test('structural identity preserves NaN and distinguishes signed zero', () => {
  const identity = makeIdentity()
  expect(identity.of({ value: NaN })).toBe(identity.of({ value: NaN }))
  expect(identity.of({ value: 0 })).not.toBe(identity.of({ value: -0 }))
})

test('identity keys distinguish signed zeros even in a Map', () => {
  const identity = makeIdentity()
  const keyed = new Map([
    [identity.of(0), 'positive'],
    [identity.of(-0), 'negative'],
  ])
  expect(keyed.size).toBe(2)
  expect(keyed.get(identity.of(0))).toBe('positive')
  expect(keyed.get(identity.of(-0))).toBe('negative')
})

test('identity includes non-enumerable fields and preserves enumeration order and prototypes', () => {
  const identity = makeIdentity()
  const hidden = Object.defineProperty({}, 'mode', { value: 'left' })
  expect(identity.of(hidden)).not.toBe(identity.of({}))
  expect(identity.of(hidden)).toBe(
    identity.of(Object.defineProperty({}, 'mode', { value: 'left' })),
  )
  expect(identity.of(hidden)).not.toBe(identity.of({ mode: 'left' }))
  expect(identity.of({ first: 1, second: 2 })).not.toBe(
    identity.of({ second: 2, first: 1 }),
  )
  expect(identity.of(Object.create(null))).not.toBe(identity.of({}))
  expect(canonical(hidden)).toBe(canonical({ mode: 'left' }))
})

test('identity distinguishes absent fields and undefined and checks colliding hashes', () => {
  const identity = makeIdentity()
  expect(Hash.hash('##')).toBe(Hash.hash('@ '))
  expect(identity.of({ value: '##' })).not.toBe(identity.of({ value: '@ ' }))
  expect(identity.of({ value: '##' })).toBe(identity.of({ value: '##' }))
  expect(identity.of({})).not.toBe(identity.of({ value: undefined }))
  expect(identity.of([undefined])).not.toBe(identity.of([]))
})

test('Options use validated payload identity rather than arbitrary Equal behavior', () => {
  const identity = makeIdentity()
  expect(identity.of(Option.some({ value: 1 }))).toBe(
    identity.of(Option.some({ value: 1 })),
  )
  expect(identity.of(Option.some(0))).not.toBe(identity.of(Option.some(-0)))
  expect(identity.of(Option.none())).not.toBe(identity.of({ _tag: 'None' }))
  expect(identity.of(Option.some(undefined))).not.toBe(
    identity.of(Option.none()),
  )
  expect(identity.of(Option.some(NaN))).toBe(identity.of(Option.some(NaN)))
})

test('unsupported identity data fails with a path and never reads getters or invokes Equal', () => {
  const identity = makeIdentity()
  const read = vi.fn(() => 1)
  const accessor = Object.defineProperty({}, 'secret', { get: read })
  expect(() => identity.of({ nested: accessor }, 'Input')).toThrow(
    'Cannot identify an accessor property at Input["nested"]["secret"]',
  )
  expect(read).not.toHaveBeenCalled()
  expect(() => identity.of({ nested: { [Symbol('hidden')]: 1 } })).toThrow(
    'Cannot identify symbol properties at $["nested"]',
  )
  expect(() => identity.of({ value: Symbol('hidden') })).toThrow(
    'Cannot identify symbol at $["value"]',
  )
  expect(() => identity.of({ value: () => 1 })).toThrow(
    'Cannot identify function at $["value"]',
  )
  const equal = vi.fn(() => true)
  class CustomEqual {
    [Equal.symbol] = equal;
    [Hash.symbol]() {
      return 0
    }
  }
  expect(() => identity.of({ value: new CustomEqual() })).toThrow(
    'Cannot identify an object with a custom prototype at $["value"]',
  )
  expect(equal).not.toHaveBeenCalled()
  expect(() => identity.of({ value: new Date() })).toThrow('custom prototype')
  expect(() => identity.of({ value: new Map() })).toThrow('custom prototype')
})

test('cycles, sparse arrays, extra array properties, and decorated Options are rejected', () => {
  const identity = makeIdentity()
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(() => identity.of(cyclic)).toThrow(
    'Cannot identify a cyclic value at $["self"]',
  )
  expect(() =>
    identity.of({ items: new globalThis.Array<unknown>(1) }),
  ).toThrow(
    'sparse arrays or arrays with extra properties or a custom prototype at $["items"]',
  )
  expect(() =>
    identity.of(Object.defineProperty([], 'extra', { value: 1 })),
  ).toThrow('arrays with extra properties')
  expect(() =>
    identity.of(Object.defineProperty(Option.some(1), 'extra', { value: 2 })),
  ).toThrow('an Option with extra properties')
  expect(() => identity.of(Option.some(cyclic))).toThrow(
    'Cannot identify a cyclic value at $["value"]["self"]',
  )
  expect(identity.of({ safe: true })).toBe(identity.of({ safe: true }))
})

test('deep freezing prevents cached identities from silently outliving mutation', () => {
  const identity = makeIdentity()
  const value = { items: [{ done: false }], maybe: Option.some({ count: 0 }) }
  const key = identity.of(value)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.items)).toBe(true)
  expect(Object.isFrozen(value.items[0])).toBe(true)
  expect(Object.isFrozen(value.maybe)).toBe(true)
  const payload = Option.getOrThrow(value.maybe)
  expect(Object.isFrozen(payload)).toBe(true)
  expect(Reflect.set(payload, 'count', 1)).toBe(false)
  expect(Reflect.set(value.items, '0', { done: true })).toBe(false)
  expect(identity.of(value)).toBe(key)
  expect(
    identity.of({ items: [{ done: false }], maybe: Option.some({ count: 0 }) }),
  ).toBe(key)
})

test('unchanged references are not rescanned when identifying an update', () => {
  const identity = makeIdentity()
  const items = Array.makeBy(10_000, index => ({ id: index, done: false }))
  const model = { items, filter: 'all' }
  const names = vi.spyOn(Object, 'getOwnPropertyNames')
  try {
    identity.of(model)
    const before = identity.size()
    names.mockClear()
    expect(identity.of(model)).toBe(model)
    identity.of({ previous: model, filter: 'active' })
    expect(names).toHaveBeenCalledTimes(1)
    expect(identity.size() - before).toBeLessThanOrEqual(2)
  } finally {
    names.mockRestore()
  }
})
