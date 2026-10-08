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

test('identifying an update costs only what the update replaced', () => {
  const identity = makeIdentity()
  const items = Array.makeBy(10_000, index => ({ id: index, done: false }))
  const model = { items, filter: 'all' }
  identity.of(model)
  const before = identity.size()
  identity.of({ ...model, filter: 'active' })
  expect(identity.size() - before).toBeLessThanOrEqual(2)
})
