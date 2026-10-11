import { Array } from 'effect'
import { expect, test } from 'vitest'

import { type Choices, fixture, outcomes } from './fixture'

const values = <Output>(choices: () => Choices<Output>) =>
  Array.map(Array.fromIterable(outcomes(choices)), ({ value }) => value)

test('nested choices compose with their own value types', () => {
  function* enabled(): Choices<boolean> {
    return yield* fixture('enabled', { no: false, yes: true })
  }
  function* user(): Choices<Readonly<{ name: string; enabled: boolean }>> {
    const name = yield* fixture('name', { alice: 'Alice', bob: 'Bob' })
    return { name, enabled: yield* enabled() }
  }
  expect(values(user)).toEqual([
    { name: 'Alice', enabled: false },
    { name: 'Alice', enabled: true },
    { name: 'Bob', enabled: false },
    { name: 'Bob', enabled: true },
  ])
})

test('control flow decides which choices exist', () => {
  function* request(): Choices<string> {
    const status = yield* fixture('status', {
      loading: 'loading',
      ready: 'ready',
    })
    if (status === 'loading') {
      return status
    }
    return yield* fixture('shape', { round: 'round', square: 'square' })
  }
  expect(
    Array.map(
      Array.fromIterable(outcomes(request)),
      ({ decisions }) => decisions,
    ),
  ).toEqual([
    [{ fixture: 'status', option: 'loading' }],
    [
      { fixture: 'status', option: 'ready' },
      { fixture: 'shape', option: 'round' },
    ],
    [
      { fixture: 'status', option: 'ready' },
      { fixture: 'shape', option: 'square' },
    ],
  ])
})

test('an empty fixture prunes its path', () => {
  function* nothing(): Choices<number> {
    yield* fixture('empty', {})
    return 42
  }
  expect(values(nothing)).toEqual([])
})

test('a fixture name may appear only once along a path', () => {
  function* twice(): Choices<number> {
    yield* fixture('same', { one: 1 })
    return yield* fixture('same', { two: 2 })
  }
  expect(() => Array.fromIterable(outcomes(twice))).toThrow('appears twice')
})

test('outcomes evaluates only demanded alternatives and resumes in order', () => {
  const completed: Array<number> = []
  function* choices(): Choices<number> {
    const value = yield* fixture('value', { first: 1, second: 2, third: 3 })
    completed.push(value)
    return value
  }
  const iterator = outcomes(choices)
  expect(completed).toEqual([])
  expect(iterator.next().value).toEqual({
    decisions: [{ fixture: 'value', option: 'first' }],
    value: 1,
  })
  expect(completed).toEqual([1])
  expect(iterator.next().value).toEqual({
    decisions: [{ fixture: 'value', option: 'second' }],
    value: 2,
  })
  expect(completed).toEqual([1, 2])
})
