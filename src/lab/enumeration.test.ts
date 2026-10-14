import { Array, Schema } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { expect, test } from 'vitest'

import { type Environment, make, send } from './atlas'
import { compare } from './compare'
import { type Choices, fixture } from './fixture'

const program = {
  name: 'Enumeration bounds',
  Model: Schema.Number,
  Message: Schema.Number,
  start: (input: number) => ({ model: input }),
  update: (_model: number, message: number) => ({ model: message }),
  view: (_model: number, h: HtmlBuilder<number>) => h.div([]),
}

function* pruned(depth: number): Choices<number> {
  for (const axis of Array.range(1, depth)) {
    yield* fixture(`axis${axis}`, { a: 0, b: 1 })
  }
  return yield* fixture('empty', {})
}

const bounds = { depth: 1, states: 100, transitions: 100, enumerationWork: 64 }

test('operation-count benchmark: both engines stop a fully pruned tree at the same allowance', () => {
  const starts = { calls: 0 }
  const environment: Environment<number, number, number> = {
    *starts() {
      starts.calls += 1
      return yield* pruned(16)
    },
  }
  const atlas = make(program, environment, { limits: bounds })
  const reached = atlas.reach(0)
  expect(reached).toMatchObject({
    states: [],
    status: 'enumeration-limit',
    counters: { states: 0, transitions: 0, starts: 0, enumerationWork: 64 },
    unfinishedWork: { starts: true },
  })
  const atFirstBound = starts.calls
  expect(atFirstBound).toBeLessThanOrEqual(64)
  expect(atlas.reach(0)).toBe(reached)
  expect(starts.calls).toBe(atFirstBound)
  const resumed = atlas.reach(0, 'breadth', { enumerationWork: 96 })
  expect(resumed.counters.enumerationWork).toBe(96)
  expect(starts.calls - atFirstBound).toBeLessThanOrEqual(32)
  expect(atlas.reach(0)).toEqual(reached)

  starts.calls = 0
  const comparison = compare({
    before: program,
    after: program,
    environment,
    limits: bounds,
  })
  expect(comparison.status).toBe('enumeration-limit')
  expect(comparison.counters).toMatchObject({
    starts: 0,
    transitions: 0,
    enumerationWork: 64,
  })
  expect(comparison.unfinishedWork[0]?.kind).toBe('starts')
  expect(starts.calls).toBe(atFirstBound)
  comparison.resume({ ...bounds, enumerationWork: 96 })
  expect(comparison.counters.enumerationWork).toBe(96)
  expect(starts.calls).toBeLessThanOrEqual(96)
})

test('both engines resume nested starts and pruned leaves to the fresh complete result', () => {
  const environment: Environment<number, number, number> = {
    *starts() {
      const input = yield* fixture('input', { one: 1, two: 2, three: 3 })
      return yield* fixture(
        'enabled',
        input === 2 ? {} : { yes: input, no: -input },
      )
    },
  }
  const low = { ...bounds, depth: 0, enumerationWork: 7 }
  const high = { ...low, enumerationWork: 1_000 }
  const atlas = make(program, environment, { limits: low })
  expect(atlas.reach(0).status).toBe('enumeration-limit')
  const resumed = atlas.reach(0, 'breadth', high)
  const freshAtlas = make(program, environment, { limits: high })
  const fresh = freshAtlas.reach(0)
  expect(resumed).toEqual(fresh)
  expect(resumed.states.map(atlas.encode)).toEqual([1, -1, 3, -3])

  const comparison = compare({
    before: program,
    after: program,
    environment,
    limits: low,
  })
  expect(comparison.status).toBe('enumeration-limit')
  comparison.resume(high)
  const freshComparison = compare({
    before: program,
    after: program,
    environment,
    limits: high,
  })
  expect(comparison.status).toBe('complete')
  expect(comparison.counters).toEqual(freshComparison.counters)
  expect(comparison.findings).toEqual(freshComparison.findings)
  expect(comparison.counters.enumerationWork).toBe(
    resumed.counters.enumerationWork,
  )
})

test('pruned successor work is bounded in all atlas searches and direct probes', () => {
  for (const search of ['breadth', 'depth', 'random']) {
    if (search !== 'breadth' && search !== 'depth' && search !== 'random') {
      return
    }
    const next = { calls: 0 }
    const atlas = make(
      program,
      {
        *starts() {
          return 0
        },
        *next() {
          next.calls += 1
          return send(yield* pruned(16))
        },
      },
      { limits: bounds },
    )
    const reached = atlas.reach(1, search)
    expect(reached.status).toBe('enumeration-limit')
    expect(reached.counters).toMatchObject({
      states: 1,
      starts: 1,
      transitions: 1,
      enumerationWork: 64,
    })
    expect(reached.unfinishedWork.states).toBe(1)
    const root = reached.states[0]
    expect(root).toBeDefined()
    if (root === undefined) {
      return
    }
    expect(atlas.successorStatus(root)).toBe('partial')
    const calls = next.calls
    expect(atlas.successors(root, { enumerationWork: 62 })).toEqual([])
    expect(next.calls).toBe(calls)
    expect(atlas.successors(root, { enumerationWork: 80 })).toEqual([])
    expect(next.calls - calls).toBeLessThanOrEqual(18)
  }
})

test('comparison successor checkpoints preserve completed alternative counters when resumed', () => {
  const environment: Environment<number, number, number> = {
    *starts() {
      return 0
    },
    *next() {
      return send(yield* pruned(4))
    },
  }
  const comparison = compare({
    before: program,
    after: program,
    environment,
    limits: bounds,
  })
  expect(comparison.status).toBe('enumeration-limit')
  expect(comparison.counters).toMatchObject({
    starts: 1,
    transitions: 1,
    beforeTransitions: 0,
    afterTransitions: 0,
    enumerationWork: 64,
  })
  const high = { ...bounds, enumerationWork: 10_000 }
  comparison.resume(high)
  const fresh = compare({
    before: program,
    after: program,
    environment,
    limits: high,
  })
  expect(comparison.status).toBe('complete')
  expect(comparison.counters).toEqual(fresh.counters)
  expect(comparison.counters.transitions).toBe(1)
  expect(() => comparison.resume({ ...high, enumerationWork: 1 })).toThrow(
    'cannot decrease',
  )
})

test('zero and invalid enumeration work allowances are explicit', () => {
  const environment: Environment<number, number, number> = {
    *starts() {
      return 0
    },
  }
  const low = { ...bounds, enumerationWork: 0 }
  expect(make(program, environment, { limits: low }).reach(0)).toMatchObject({
    status: 'enumeration-limit',
    counters: { enumerationWork: 0, transitions: 0 },
  })
  expect(
    compare({ before: program, after: program, environment, limits: low })
      .status,
  ).toBe('enumeration-limit')
  expect(() =>
    make(program, environment, { limits: { enumerationWork: -1 } }),
  ).toThrow('Enumeration work limit')
  expect(() =>
    compare({
      before: program,
      after: program,
      environment,
      limits: { ...bounds, enumerationWork: 1.5 },
    }),
  ).toThrow('Enumeration work limit')
})
