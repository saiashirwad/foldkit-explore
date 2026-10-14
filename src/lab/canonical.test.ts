import { Option } from 'effect'
import { expect, test } from 'vitest'

import { canonical } from './canonical'

test('sorts record keys recursively without changing array order', () => {
  expect(canonical({ b: [{ z: 2, a: 1 }], a: 0 })).toBe(
    canonical({ a: 0, b: [{ a: 1, z: 2 }] }),
  )
  expect(canonical([1, 2])).not.toBe(canonical([2, 1]))
  expect(canonical([])).toBe('[]')
})

test('distinguishes values JSON would omit or collapse', () => {
  const values = [
    {},
    { value: undefined },
    { value: null },
    { value: NaN },
    { value: Infinity },
    { value: -Infinity },
    { value: 0 },
    { value: -0 },
    { value: 0n },
    { value: '0n' },
    { value: Option.none() },
    { value: Option.some(undefined) },
    { value: Option.some(null) },
    { value: { _id: 'Option', _tag: 'None' } },
  ]
  expect(new Set(values.map(canonical)).size).toBe(values.length)
})

test('compares Option payloads structurally and permits shared references', () => {
  const shared = { first: 1, second: 2 }
  expect(canonical(Option.some(shared))).toBe(
    canonical(Option.some({ second: 2, first: 1 })),
  )
  expect(canonical([shared, shared])).toBe(
    canonical([
      { first: 1, second: 2 },
      { second: 2, first: 1 },
    ]),
  )
})

test('rejects unsupported values instead of erasing their meaning', () => {
  expect(() => canonical(() => 1)).toThrow('Cannot canonicalize function')
  expect(() => canonical(Symbol('choice'))).toThrow(
    'Cannot canonicalize symbol',
  )
  expect(() => canonical(new Date('2026-01-01'))).toThrow('custom prototype')
  expect(() => canonical(new Map([['choice', 1]]))).toThrow('custom prototype')
  expect(() => canonical({ [Symbol('choice')]: 1 })).toThrow(
    'symbol properties',
  )
  expect(() => canonical(new Array(1))).toThrow('sparse arrays')
  expect(() =>
    canonical(Object.defineProperty([1], 'extra', { value: 2 })),
  ).toThrow('extra properties')
  expect(() =>
    canonical(Object.defineProperty({}, 'choice', { get: () => 1 })),
  ).toThrow('accessor property')
})

test('rejects cycles with an explicit diagnostic', () => {
  const value: Record<string, unknown> = {}
  value.self = value
  expect(() => canonical(value)).toThrow(
    'Cannot canonicalize a cyclic value at $["self"]',
  )
})
