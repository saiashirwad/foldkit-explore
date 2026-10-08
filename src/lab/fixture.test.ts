import { Array } from 'effect'
import { expect, test } from 'vitest'

import { type Choices, fixture, outcomes } from './fixture'

const values = <Output>(choices: () => Choices<Output>) =>
  Array.map(outcomes(choices), ({ value }) => value)

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
  expect(Array.map(outcomes(request), ({ decisions }) => decisions)).toEqual([
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
  expect(() => outcomes(twice)).toThrow('appears twice')
})
