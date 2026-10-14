import { Array } from 'effect'
import { expect, test } from 'vitest'

import { type Choices, enumerate, fixture, outcomes } from './fixture'

const values = <Output>(choices: () => Choices<Output>) =>
  Array.map(Array.fromIterable(outcomes(choices)), ({ value }) => value)

test('fixtures preserve NaN, signed zero, undefined, and offered references', () => {
  const offered = { name: 'Ada' }
  function* choices(): Choices<unknown> {
    return yield* fixture<unknown>('value', {
      nan: NaN,
      zero: 0,
      negativeZero: -0,
      missing: undefined,
      object: offered,
    })
  }
  const result = values(choices)
  expect(result).toHaveLength(5)
  expect(result[0]).toBeNaN()
  expect(result[1]).toBe(0)
  expect(result[2]).toBe(-0)
  expect(result[3]).toBeUndefined()
  expect(result[4]).toBe(offered)
})

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

const pruned = (depth: number): Choices<number> =>
  (function* () {
    for (const axis of Array.range(1, depth)) {
      yield* fixture(`axis${axis}`, { a: 0, b: 1 })
    }
    return yield* fixture('pruned', {})
  })()

test('a fully pruned tree yields checkpoints and cancellation releases its active generator', () => {
  const calls = { starts: 0, closed: 0 }
  function* choices(): Choices<number> {
    calls.starts += 1
    try {
      return yield* pruned(16)
    } finally {
      calls.closed += 1
    }
  }
  const cursor = enumerate(choices)
  const steps = Array.makeBy(64, () => cursor.next())
  expect(steps.every(step => !step.done && step.value.kind === 'work')).toBe(
    true,
  )
  expect(calls.starts).toBeLessThanOrEqual(64)
  expect(calls.closed).toBe(calls.starts - 1)
  cursor.return()
  expect(calls.closed).toBe(calls.starts)
  expect(cursor.next().done).toBe(true)
})

test('checkpointed nested and empty branches resume without dropping outcomes', () => {
  function* choices(): Choices<number> {
    const first = yield* fixture('first', { one: 1, two: 2, three: 3 })
    return yield* fixture('second', first === 2 ? {} : { a: first, b: -first })
  }
  const cursor = enumerate(choices)
  const prefix = Array.makeBy(5, () => cursor.next())
  expect(prefix.every(step => !step.done && step.value.kind === 'work')).toBe(
    true,
  )
  const rest = Array.fromIterable(cursor)
  expect(
    Array.flatMap(rest, step =>
      step.kind === 'outcome' ? [step.outcome] : [],
    ),
  ).toEqual(Array.fromIterable(outcomes(choices)))
})

test('operation-count benchmark: wide siblings need constant work before the first outcome', () => {
  const offered = Object.fromEntries(
    Array.makeBy(50_000, index => [String(index), index]),
  )
  const completed: Array<number> = []
  function* choices(): Choices<number> {
    const value = yield* fixture('wide', offered)
    completed.push(value)
    return value
  }
  const cursor = enumerate(choices)
  const first = Array.makeBy(4, () => cursor.next())
  expect(first.map(step => step.value?.kind)).toEqual([
    'work',
    'work',
    'work',
    'outcome',
  ])
  expect(first.at(-1)?.value).toEqual({
    kind: 'outcome',
    outcome: { decisions: [{ fixture: 'wide', option: '0' }], value: 0 },
  })
  expect(completed).toEqual([0])
  cursor.return()
})
