import { Array, Effect, Option, Schema } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { expect, test } from 'vitest'

import { makeRunner } from './analysis-runner'
import { type Address, make, send } from './atlas'
import { compare } from './compare'
import { type Choices, fixture, replaySteps } from './fixture'
import {
  ReplayCancelledError,
  ReplayDivergenceError,
  ReplayLimitError,
  finishReplay,
} from './replay'

const numberProgram = {
  name: 'Selected replay',
  Model: Schema.Number,
  Message: Schema.Number,
  start: (input: number) => ({ model: input }),
  update: (_model: number, message: number) => ({ model: message }),
  view: (_model: number, h: HtmlBuilder<number>) => h.div([]),
}
const startHop = {
  kind: 'Start',
  decisions: [],
  maybeMessage: Option.none(),
} satisfies Address[number]
const moveHop = {
  kind: 'Move',
  decisions: [{ fixture: 'move', option: 'one' }],
  maybeMessage: Option.some(1),
} satisfies Address[number]

const divergence = (run: () => unknown): ReplayDivergenceError => {
  try {
    run()
  } catch (error) {
    if (error instanceof ReplayDivergenceError) {
      return error
    }
    throw error
  }
  throw new Error('Expected a typed replay divergence.')
}

const wide = Object.fromEntries(
  Array.makeBy(50_000, index => [String(index), index]),
)

test('resolving the final 50,000-option start completes and publishes only its selected input', () => {
  const started: Array<number> = []
  const completed: Array<number> = []
  const calls = { opened: 0, closed: 0 }
  const atlas = make(
    {
      ...numberProgram,
      start: input => {
        started.push(input)
        return { model: input }
      },
    },
    {
      *starts() {
        calls.opened += 1
        try {
          const chosen = yield* fixture('wide', wide)
          completed.push(chosen)
          return chosen
        } finally {
          calls.closed += 1
        }
      },
    },
    { limits: { states: 0, transitions: 0, enumerationWork: 0 } },
  )
  const selected = Option.getOrThrow(
    atlas.resolve(
      [{ ...startHop, decisions: [{ fixture: 'wide', option: '49999' }] }],
      { limits: { hops: 1, work: 10 } },
    ),
  )
  expect(atlas.encode(selected)).toBe(49_999)
  expect(atlas.snapshot()).toHaveLength(1)
  expect(started).toEqual([49_999])
  expect(completed).toEqual([49_999])
  expect(calls).toEqual({ opened: 1, closed: 1 })
  expect(atlas.fixtures()).toEqual([{ name: 'wide', options: ['49999'] }])
})

test('resolving the final 50,000-option transition never enumerates its siblings', () => {
  const updated: Array<number> = []
  const chosen: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      update: (_model, message) => {
        updated.push(message)
        return { model: message }
      },
    },
    {
      *starts() {
        return -1
      },
      *next() {
        const message = yield* fixture('wide', wide)
        chosen.push(message)
        return send(message)
      },
    },
  )
  const replay = atlas.resolveSteps(
    [
      startHop,
      {
        kind: 'Move',
        decisions: [{ fixture: 'wide', option: '49999' }],
        maybeMessage: Option.some(49_999),
      },
    ],
    { limits: { work: 20 } },
  )
  const selected = Option.getOrThrow(finishReplay(replay))
  expect(atlas.encode(selected)).toBe(49_999)
  expect(updated).toEqual([49_999])
  expect(chosen).toEqual([49_999])
  const states = atlas.snapshot()
  expect(states).toHaveLength(2)
  expect(states[0]?.successorStatus).toBe('unseen')
  expect(states[0]?.next).toEqual([])
})

test('missing/renamed options and incomplete/excessive decisions have distinct typed failures', () => {
  const atlas = make(numberProgram, {
    *starts() {
      return yield* fixture('start', { chosen: 0 })
    },
  })
  const address = (decisions: Address[number]['decisions']): Address => [
    { ...startHop, decisions },
  ]
  expect(
    divergence(() =>
      atlas.resolve(address([{ fixture: 'renamed', option: 'chosen' }])),
    ).reason,
  ).toBe('fixture')
  expect(
    divergence(() =>
      atlas.resolve(address([{ fixture: 'start', option: 'missing' }])),
    ).reason,
  ).toBe('option')
  expect(divergence(() => atlas.resolve(address([]))).reason).toBe(
    'incomplete-decisions',
  )
  expect(
    divergence(() =>
      atlas.resolve(
        address([
          { fixture: 'start', option: 'chosen' },
          { fixture: 'extra', option: 'choice' },
        ]),
      ),
    ).reason,
  ).toBe('excessive-decisions')
  expect(atlas.snapshot()).toEqual([])
})

test('cached navigation addresses never bypass changed semantic Message validation', () => {
  const offered = { message: 1 }
  const atlas = make(numberProgram, {
    *starts() {
      return 0
    },
    *next() {
      return send(yield* fixture('move', { one: offered.message }))
    },
  })
  const root = Option.getOrThrow(atlas.resolve([startHop]))
  const target = atlas.successors(root)[0]?.to
  if (target === undefined) {
    throw new Error('Missing selected successor.')
  }
  const address = atlas.address(target)
  expect(address[1]?.maybeMessage).toEqual(Option.some(1))
  offered.message = 2
  expect(divergence(() => atlas.resolve(address)).reason).toBe('message')
  expect(
    divergence(() => finishReplay(atlas.resolveSteps(address))).reason,
  ).toBe('message')
})

test('invalid start, transition and Event hop kinds fail explicitly', () => {
  const atlas = make(numberProgram, {
    *starts() {
      return 0
    },
    *next() {
      return send(yield* fixture('move', { one: 1 }))
    },
  })
  const invalid: ReadonlyArray<Address> = [
    [],
    [moveHop],
    [{ ...startHop, maybeMessage: Option.some(0) }],
    [startHop, startHop],
    [startHop, { ...moveHop, kind: 'Answer' }],
    [startHop, { ...moveHop, maybeMessage: Option.none() }],
    [startHop, { ...moveHop, kind: 'Event' }],
  ]
  Array.forEach(invalid, address => {
    expect(divergence(() => atlas.resolve(address)).reason).toBe('hop-kind')
  })
  expect(
    divergence(() =>
      atlas.resolve([
        startHop,
        {
          kind: 'Event',
          decisions: [],
          maybeMessage: Option.some('not a Number'),
        },
      ]),
    ).reason,
  ).toBe('message')
})

test('hop/work allowances stop before user work and long selected paths clean up at exhaustion', () => {
  const calls = { opened: 0, closed: 0, advanced: 0, started: 0 }
  const depth = 100
  const atlas = make(
    {
      ...numberProgram,
      start: input => {
        calls.started += 1
        return { model: input }
      },
    },
    {
      *starts() {
        calls.opened += 1
        try {
          for (const index of Array.range(0, depth - 1)) {
            calls.advanced += 1
            yield* fixture(String(index), { chosen: index })
          }
          return 0
        } finally {
          calls.closed += 1
        }
      },
    },
  )
  const address: Address = [
    {
      ...startHop,
      decisions: Array.makeBy(depth, index => ({
        fixture: String(index),
        option: 'chosen',
      })),
    },
  ]
  expect(() => atlas.resolve(address, { limits: { hops: 0 } })).toThrow(
    ReplayLimitError,
  )
  expect(() => atlas.resolve(address, { limits: { work: 0 } })).toThrow(
    ReplayLimitError,
  )
  expect(calls).toEqual({ opened: 0, closed: 0, advanced: 0, started: 0 })
  expect(() => atlas.resolve(address, { limits: { work: 10 } })).toThrow(
    ReplayLimitError,
  )
  expect(calls.opened).toBe(1)
  expect(calls.closed).toBe(1)
  expect(calls.advanced).toBeLessThanOrEqual(10)
  expect(calls.started).toBe(0)
  expect(atlas.snapshot()).toEqual([])
  expect(() => atlas.resolve(address, { limits: { work: -1 } })).toThrow(
    RangeError,
  )
})

test('checkpoint cancellation and iterator disposal close authored replay generators', () => {
  const calls = { opened: 0, closed: 0 }
  const atlas = make(numberProgram, {
    *starts() {
      calls.opened += 1
      try {
        for (const index of Array.range(0, 99)) {
          yield* fixture(String(index), { chosen: index })
        }
        return 0
      } finally {
        calls.closed += 1
      }
    },
  })
  const address: Address = [
    {
      ...startHop,
      decisions: Array.makeBy(100, index => ({
        fixture: String(index),
        option: 'chosen',
      })),
    },
  ]
  const signal = new AbortController()
  const replay = atlas.resolveSteps(address, { signal: signal.signal })
  Array.makeBy(8, () => replay.next())
  expect(calls).toEqual({ opened: 1, closed: 0 })
  signal.abort()
  expect(() => replay.next()).toThrow(ReplayCancelledError)
  expect(calls).toEqual({ opened: 1, closed: 1 })
  const disposed: Iterator<void, Option.Option<string>> = atlas.resolveSteps(
    address,
  )
  Array.makeBy(8, () => disposed.next())
  disposed.return?.()
  expect(calls).toEqual({ opened: 2, closed: 2 })
})

test('selected fixture replay rejects leftover decisions even after a generator completed', () => {
  function* choices(): Choices<number> {
    return 0
  }
  expect(
    divergence(() =>
      finishReplay(
        replaySteps(choices, [{ fixture: 'extra', option: 'chosen' }]),
      ),
    ).reason,
  ).toBe('excessive-decisions')
})

test('Comparison missing-event verification accounts for fully pruned fixture work', () => {
  const state = { deep: false, opened: 0, closed: 0 }
  const comparison = compare({
    before: { ...numberProgram, start: () => ({ model: 0 }) },
    after: { ...numberProgram, start: () => ({ model: 10 }) },
    environment: {
      *starts() {
        return 0
      },
      *next({ model }) {
        if (model === 0) {
          return send(1)
        }
        state.opened += 1
        try {
          if (state.deep) {
            for (const index of Array.range(0, 19)) {
              yield* fixture(String(index), { a: 0, b: 1 })
            }
          }
          return send(yield* fixture('pruned', {}))
        } finally {
          state.closed += 1
        }
      },
    },
    limits: { depth: 1, states: 10, transitions: 10, enumerationWork: 64 },
  })
  const missing = comparison.findings.find(
    finding => finding.kind === 'event-removed',
  )
  if (missing === undefined) {
    throw new Error('Missing unmatched event fixture.')
  }
  state.deep = true
  expect(() => comparison.replay(missing.shortest.trace)).toThrow(
    ReplayLimitError,
  )
  expect(state.opened).toBe(state.closed)
  const signal = new AbortController()
  const replay = comparison.replaySteps(missing.shortest.trace, {
    signal: signal.signal,
  })
  Array.makeBy(12, () => replay.next())
  signal.abort()
  expect(() => replay.next()).toThrow(ReplayCancelledError)
  expect(state.opened).toBe(state.closed)
})

test('undefined and bigint Messages retain navigation keys and replay semantics', () => {
  const bigint = make(
    {
      ...numberProgram,
      Message: Schema.BigInt,
      update: (_model, message: bigint) => ({ model: Number(message) }),
      view: (_model, h: HtmlBuilder<bigint>) => h.div([]),
    },
    {
      *starts() {
        return 0
      },
    },
  )
  const root = Option.getOrThrow(bigint.resolve([startHop]))
  const target = Option.getOrThrow(bigint.interact(root, 1n))
  expect(() => bigint.key(target)).not.toThrow()
  const fresh = bigint.fresh()
  expect(
    fresh.encode(Option.getOrThrow(fresh.resolve(bigint.address(target)))),
  ).toBe(1)

  const absent = make(
    {
      ...numberProgram,
      Message: Schema.Undefined,
      update: (model, _message: undefined) => ({ model: model + 1 }),
      view: (_model, h: HtmlBuilder<undefined>) => h.div([]),
    },
    {
      *starts() {
        return 0
      },
      *next() {
        return send(undefined)
      },
    },
  )
  const address: Address = [
    startHop,
    { kind: 'Move', decisions: [], maybeMessage: Option.some(undefined) },
  ]
  expect(absent.encode(Option.getOrThrow(absent.resolve(address)))).toBe(1)
})

test('Message codecs that lose signed zero fail before applying an unfaithful event', () => {
  const updated: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      Message: Schema.NumberFromString,
      update: (_model, message) => {
        updated.push(message)
        return { model: message }
      },
    },
    {
      *starts() {
        return 1
      },
      *next() {
        return send(-0)
      },
    },
  )
  const root = Option.getOrThrow(atlas.resolve([startHop]))
  expect(divergence(() => atlas.interact(root, -0)).reason).toBe('message')
  expect(divergence(() => atlas.successors(root)).reason).toBe('message')
  expect(updated).toEqual([])
})

test('typed replay cancellation composes with the scoped runner cancellation result and disposal', async () => {
  const calls = { disposed: 0 }
  const runner = makeRunner()
  const result = await Effect.runPromise(
    runner.run(
      { runId: 1, key: 'replay', reset: false },
      () => ({
        dispose: () => {
          calls.disposed += 1
        },
      }),
      () => {
        throw new ReplayCancelledError()
      },
      0,
    ),
  )
  expect(result.status._tag).toBe('Cancelled')
  expect(result.maybeValue).toEqual(Option.none())
  expect(calls.disposed).toBe(1)
  await Effect.runPromise(runner.shutdown)
  expect(calls.disposed).toBe(1)
})

test('Comparison fresh evidence checks raw Models even when a Model codec collapses signed zero', () => {
  const setup = { before: 0 }
  const comparison = compare({
    before: {
      ...numberProgram,
      Model: Schema.NumberFromString,
      start: () => ({ model: setup.before }),
      view: (_model, h) => h.div([], ['before']),
    },
    after: {
      ...numberProgram,
      Model: Schema.NumberFromString,
      start: () => ({ model: 0 }),
      view: (_model, h) => h.div([], ['after']),
    },
    environment: {
      *starts() {
        return 0
      },
    },
    limits: { depth: 0, states: 10, transitions: 10 },
  })
  const trace = comparison.findings[0]?.shortest.trace
  if (trace === undefined) {
    throw new Error('Expected a root observation finding.')
  }
  setup.before = -0
  expect(divergence(() => comparison.replay(trace)).reason).toBe('evidence')
})
