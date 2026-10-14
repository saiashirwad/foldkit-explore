import { Array } from 'effect'
import { expect, test } from 'vitest'

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

test('array identity includes length and distinguishes holes from undefined', () => {
  const identity = makeIdentity()
  const oneHole = new globalThis.Array<unknown>(1)
  const twoHoles = new globalThis.Array<unknown>(2)
  expect(identity.of(oneHole)).toBe(
    identity.of(new globalThis.Array<unknown>(1)),
  )
  expect(identity.of(oneHole)).not.toBe(identity.of(twoHoles))
  expect(identity.of(oneHole)).not.toBe(identity.of([]))
  expect(identity.of(oneHole)).not.toBe(identity.of([undefined]))
})

test('unchanged references are not rescanned when identifying an update', () => {
  const identity = makeIdentity()
  const reads = { value: 0 }
  const items = Array.makeBy(10_000, index => ({ id: index, done: false }))
  const model = {
    get items() {
      reads.value += 1
      return items
    },
    filter: 'all',
  }
  identity.of(model)
  const before = identity.size()
  expect(identity.of(model)).toBe(model)
  expect(reads.value).toBe(1)
  identity.of({ previous: model, filter: 'active' })
  expect(reads.value).toBe(1)
  expect(identity.size() - before).toBeLessThanOrEqual(2)
})
