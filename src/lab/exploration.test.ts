import { Array, Option, Schema } from 'effect'
import { expect, test } from 'vitest'

import { signupProgram } from '../programs'
import * as Signup from '../signup/main'
import {
  longUsername,
  signupEnvironment,
  signupLongContentEnvironment,
} from '../signup/main.cases'
import { properties } from '../signup/properties'
import {
  type Atlas,
  type Environment,
  describe,
  make,
  send as move,
} from './atlas'
import { fixture } from './fixture'

const signup = (environment = signupEnvironment) =>
  make(signupProgram, environment, { properties })
const start = (atlas: Atlas) =>
  Option.getOrThrow(Array.head(atlas.reach(0).states))
const send = (atlas: Atlas, state: string, message: Signup.Message) =>
  Option.getOrThrow(atlas.interact(state, message))
const answer = (atlas: Atlas, state: string, label: string) =>
  Option.getOrThrow(
    Array.findFirst(atlas.successors(state), step => step.label === label),
  ).to

const checkingTwice = (atlas: Atlas) => {
  const ada = send(
    atlas,
    start(atlas),
    Signup.Message.UpdatedUsername({ value: 'ada' }),
  )
  return send(atlas, ada, Signup.Message.UpdatedUsername({ value: 'grace' }))
}

test('next chooses any pending command, removes the chosen command and replays its address in a fresh atlas', () => {
  const atlas = signup()
  const checking = checkingTwice(atlas)
  const newestFirst = answer(atlas, checking, 'CheckUsername #2 check 1 free')
  expect(atlas.pending(newestFirst)).toEqual([
    { name: 'CheckUsername', args: '{"username":"ada"}' },
  ])
  expect(atlas.encode(newestFirst)).toMatchObject({
    username: 'grace',
    availability: { _tag: 'Free' },
  })
  const staleLast = answer(atlas, newestFirst, 'CheckUsername #1 check 0 taken')
  expect(atlas.encode(staleLast)).toEqual(atlas.encode(newestFirst))
  expect(atlas.pending(staleLast)).toEqual([])
  const fresh = signup()
  const resolved = Option.getOrThrow(fresh.resolve(atlas.address(newestFirst)))
  expect(fresh.encode(resolved)).toEqual(atlas.encode(newestFirst))
  expect(fresh.pending(resolved)).toEqual(atlas.pending(newestFirst))
})

test('screens group different pending queues without merging execution states', () => {
  const atlas = signup()
  const first = send(
    atlas,
    start(atlas),
    Signup.Message.UpdatedUsername({ value: 'ada' }),
  )
  const second = send(
    atlas,
    first,
    Signup.Message.UpdatedUsername({ value: 'grace' }),
  )
  const third = send(
    atlas,
    second,
    Signup.Message.UpdatedUsername({ value: 'ada' }),
  )
  expect(first).not.toBe(third)
  expect(atlas.groups([first, second, third])).toEqual([
    { home: first, states: [first, third] },
    { home: second, states: [second] },
  ])
  expect(atlas.pending(first)).toHaveLength(1)
  expect(atlas.pending(third)).toHaveLength(3)
})

test('signup properties hold within depth 8 without claiming complete exploration', () => {
  const atlas = signup()
  expect(atlas.check(8)).toEqual([])
  expect(atlas.reach(8).status).not.toBe('complete')
  expect(atlas.groups(atlas.reach(8).states).length).toBeLessThan(
    atlas.reach(8).states.length,
  )
})

const counter = () =>
  make(
    {
      name: 'Counter',
      Model: Schema.Number,
      Message: Schema.Number,
      start: () => ({ model: 0 }),
      update: (_model, message) => ({ model: message }),
      view: (_model, h) => h.div([]),
    },
    {
      *starts() {
        return
      },
      *next({ model }) {
        return move(
          yield* fixture(
            'move',
            model === 0
              ? { long: 1, short: 3 }
              : model === 1
                ? { onwards: 2 }
                : model === 2 || model === 3
                  ? { finish: 4 }
                  : {},
          ),
        )
      },
    },
    {
      properties: [
        { name: 'state', state: ({ model }) => model !== 4 },
        { name: 'transition', transition: (_before, message) => message !== 4 },
      ],
    },
  )

test('counterexamples use shortest explored paths, not earlier live-event discovery', () => {
  const atlas = counter()
  const root = start(atlas)
  const one = Option.getOrThrow(atlas.interact(root, 1))
  const two = Option.getOrThrow(atlas.interact(one, 2))
  const three = Option.getOrThrow(atlas.interact(two, 4))
  expect(atlas.trace(three)).toHaveLength(4)
  expect(atlas.check(0)).toEqual([])
  expect(
    atlas
      .check(3)
      .map(failure => [
        failure.property,
        failure.trace.map(step => step.label),
      ]),
  ).toEqual([
    ['transition', ['start', 'short', 'finish']],
    ['state', ['start', 'short', 'finish']],
  ])
})

test('depth-first reaches the breadth-first states at the same depth, in its own order', () => {
  const atlas = signup()
  const breadth = atlas.reach(4)
  const depth = atlas.reach(4, 'depth')
  expect(new Set(depth.states)).toEqual(new Set(breadth.states))
  expect(depth.states).not.toEqual(breadth.states)
  expect(depth.status).toBe(breadth.status)
})

test('long-content Confirm is discovered and its address replays in a fresh atlas', () => {
  const atlas = signup(signupLongContentEnvironment)
  const confirm = Option.getOrThrow(
    Array.findFirst(atlas.reach(4).states, state => {
      const model = Schema.decodeUnknownSync(Signup.Model)(atlas.encode(state))
      return model.step._tag === 'Confirm' && model.username === longUsername
    }),
  )
  expect(atlas.trace(confirm).map(step => step.kind)).toEqual([
    'Start',
    'Move',
    'Answer',
    'Move',
    'Move',
  ])
  const fresh = signup(signupLongContentEnvironment)
  const resolved = Option.getOrThrow(fresh.resolve(atlas.address(confirm)))
  expect(fresh.encode(resolved)).toEqual(atlas.encode(confirm))
  expect(fresh.pending(resolved)).toEqual(atlas.pending(confirm))
})

const terminalStarts = (count: number) =>
  make(
    {
      name: 'Terminal starts',
      Model: Schema.Number,
      Message: Schema.Number,
      start: (input: number) => ({ model: input }),
      update: (model, _message) => ({ model }),
      view: (_model, h) => h.div([]),
    },
    {
      *starts() {
        return yield* fixture(
          'start',
          Object.fromEntries(
            Array.makeBy(count, index => [String(index), index]),
          ),
        )
      },
    },
  )

test('random completeness requires every starting state, not only closed sampled paths', () => {
  const atlas = terminalStarts(40)
  expect(atlas.reach(0).states).toHaveLength(40)
  expect(atlas.reach(0).status).toBe('complete')
  expect(atlas.reach(0, 'random').states.length).toBeLessThanOrEqual(32)
  expect(atlas.reach(0, 'random').status).not.toBe('complete')
  expect(terminalStarts(1).reach(0, 'random').status).toBe('complete')
})

test('random walks repeat exactly, and deeper walks extend shallower ones', () => {
  const atlas = signup()
  const shallow = atlas.reach(3, 'random')
  const deep = atlas.reach(5, 'random')
  expect(signup().reach(3, 'random').states).toEqual(shallow.states)
  expect(Array.every(shallow.states, id => deep.states.includes(id))).toBe(true)
  expect(
    Array.every(deep.states, id => atlas.reach(5).states.includes(id)),
  ).toBe(true)
})

const numberProgram = {
  name: 'Bounded counter',
  Model: Schema.Number,
  Message: Schema.Number,
  start: (input: number) => ({ model: input }),
  update: (_model: number, message: number) => ({ model: message }),
  view: (_model: number, h: import('foldkit/html').HtmlBuilder<number>) =>
    h.div([]),
}

const numbers = (count: number) =>
  Object.fromEntries(Array.makeBy(count, index => [String(index), index]))

test('a state cap stops within starting alternatives and resumes the buffered start', () => {
  const started: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      start: (input: number) => {
        started.push(input)
        return { model: input }
      },
    },
    {
      *starts() {
        return yield* fixture('start', numbers(8))
      },
    },
    { limits: { states: 2 } },
  )
  const first = atlas.reach(0)
  expect(first.states.map(atlas.encode)).toEqual([0, 1])
  expect(first.status).toBe('state-limit')
  expect(first.unfinishedWork.starts).toBe(true)
  expect(started).toEqual([0, 1, 2])
  atlas.reach(0)
  expect(started).toEqual([0, 1, 2])
  const resumed = atlas.reach(0, 'breadth', { states: 8 })
  expect(resumed.states.map(atlas.encode)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(resumed.status).toBe('complete')
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(atlas.reach(0).states).toHaveLength(2)
})

test('duplicate start outcomes consume work without filling the state budget', () => {
  const environment: Environment<number, number, number> = {
    *starts() {
      yield* fixture('duplicate', numbers(100))
      return 0
    },
  }
  const atlas = make(numberProgram, environment, {
    limits: { states: 5, transitions: 4 },
  })
  expect(atlas.reach(0)).toMatchObject({
    status: 'transition-limit',
    counters: { states: 1, transitions: 4, starts: 4 },
    unfinishedWork: { starts: true },
  })
  expect(atlas.reach(0, 'breadth', { transitions: 101 })).toMatchObject({
    status: 'complete',
    counters: { states: 1, transitions: 100, starts: 100 },
  })
})

test('duplicate successor alternatives consume transition work and resume without rerunning update', () => {
  const updates: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      update: (model, message) => {
        updates.push(message)
        return { model }
      },
    },
    {
      *starts() {
        return 0
      },
      *next() {
        return move(yield* fixture('duplicate', numbers(100)))
      },
    },
    { limits: { states: 5, transitions: 4 } },
  )
  expect(atlas.reach(1)).toMatchObject({
    status: 'transition-limit',
    counters: { states: 1, transitions: 4, starts: 1 },
  })
  expect(updates).toEqual([0, 1, 2])
  expect(atlas.successorStatus(start(atlas))).toBe('partial')
  atlas.reach(1)
  atlas.check(1)
  describe(atlas, 1)
  expect(updates).toEqual([0, 1, 2])
  const resumed = atlas.reach(1, 'breadth', { transitions: 102 })
  expect(resumed.status).toBe('complete')
  expect(resumed.counters).toEqual({ states: 1, transitions: 101, starts: 1 })
  expect(updates).toEqual(Array.range(0, 99))
})

test('large successor fanout stops at the exact state cap and retains the next outcome', () => {
  const updates: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      update: (_model, message) => {
        updates.push(message)
        return { model: message }
      },
    },
    {
      *starts() {
        return -1
      },
      *next({ model }) {
        return move(yield* fixture('next', model === -1 ? numbers(100) : {}))
      },
    },
    { limits: { states: 3 } },
  )
  const first = atlas.reach(1)
  expect(first.states.map(atlas.encode)).toEqual([-1, 0, 1])
  expect(first.status).toBe('state-limit')
  expect(updates).toEqual([0, 1, 2])
  expect(atlas.knownSuccessors(start(atlas))).toHaveLength(2)
  const resumed = atlas.reach(1, 'breadth', { states: 6 })
  expect(resumed.states.map(atlas.encode)).toEqual([-1, 0, 1, 2, 3, 4])
  expect(updates).toEqual([0, 1, 2, 3, 4, 5])
})

test('depth zero reports its unfinished successor without publishing a deeper state', () => {
  const updates: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      update: (_model, message) => {
        updates.push(message)
        return { model: message }
      },
    },
    {
      *starts() {
        return 0
      },
      *next({ model }) {
        return move(model + 1)
      },
    },
  )
  const initial = atlas.reach(0)
  expect(initial.states.map(atlas.encode)).toEqual([0])
  expect(initial.status).toBe('depth-limit')
  expect(initial.unfinishedWork).toEqual({
    starts: false,
    states: 1,
    transitions: 1,
  })
  expect(updates).toEqual([1])
  describe(atlas, 0)
  atlas.check(0)
  expect(updates).toEqual([1])
  expect(atlas.reach(1).states.map(atlas.encode)).toEqual([0, 1])
  expect(updates).toEqual([1, 2])
})

test('breadth, depth, and random searches obey absolute work and state bounds', () => {
  Array.forEach(['breadth', 'depth', 'random'], search => {
    if (search !== 'breadth' && search !== 'depth' && search !== 'random') {
      return
    }
    const atlas = make(numberProgram, {
      *starts() {
        return 0
      },
      *next({ model }) {
        return move(
          yield* fixture('increment', { one: model + 1, two: model + 2 }),
        )
      },
    })
    const reached = atlas.reach(100, search, { states: 3, transitions: 4 })
    expect(reached.states.length).toBeLessThanOrEqual(3)
    expect(reached.counters.transitions).toBeLessThanOrEqual(4)
    expect(reached.status).not.toBe('complete')
    const resumed = atlas.reach(100, search, { states: 6, transitions: 10 })
    expect(resumed.states.length).toBeLessThanOrEqual(6)
    expect(resumed.counters.transitions).toBeLessThanOrEqual(10)
  })
})

test('depth-first search uses a bounded stack for a long chain', () => {
  const atlas = make(numberProgram, {
    *starts() {
      return 0
    },
    *next({ model }) {
      return move(model + 1)
    },
  })
  expect(atlas.reach(10_000, 'depth', { states: 2_000 })).toMatchObject({
    status: 'state-limit',
    counters: { states: 2_000 },
  })
})

test('direct successor inspection is bounded and resumes only with a higher limit', () => {
  const updates: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      update: (_model, message) => {
        updates.push(message)
        return { model: message }
      },
    },
    {
      *starts() {
        return -1
      },
      *next({ model }) {
        return move(yield* fixture('move', model === -1 ? numbers(10) : {}))
      },
    },
    { limits: { states: 2, transitions: 20 } },
  )
  const root = start(atlas)
  expect(atlas.successors(root).map(step => atlas.encode(step.to))).toEqual([0])
  expect(updates).toEqual([0, 1])
  expect(atlas.successorStatus(root)).toBe('partial')
  atlas.successors(root)
  expect(updates).toEqual([0, 1])
  expect(
    atlas.successors(root, { states: 4 }).map(step => atlas.encode(step.to)),
  ).toEqual([0, 1, 2])
  expect(updates).toEqual([0, 1, 2, 3])
})

test('passive successor reads do not prepare or publish buffered alternatives', () => {
  const updates: Array<number> = []
  const atlas = make(
    {
      ...numberProgram,
      update: (_model, message) => {
        updates.push(message)
        return { model: message }
      },
    },
    {
      *starts() {
        return -1
      },
      *next({ model }) {
        return move(yield* fixture('move', model === -1 ? numbers(3) : {}))
      },
    },
  )
  const root = Option.getOrThrow(
    Array.head(atlas.reach(0, 'breadth', { transitions: 1 }).states),
  )
  expect(atlas.successorStatus(root)).toBe('unseen')
  expect(atlas.knownSuccessors(root)).toEqual([])
  expect(updates).toEqual([])

  const published = atlas.successors(root, { states: 2 })
  expect(published).toHaveLength(1)
  expect(updates).toEqual([0, 1])
  expect(atlas.successorStatus(root)).toBe('partial')
  expect(atlas.knownSuccessors(root)).toEqual(published)
  expect(updates).toEqual([0, 1])

  const resumed = atlas.successors(root, { states: 4 })
  expect(resumed.map(step => atlas.encode(step.to))).toEqual([0, 1, 2])
  expect(resumed[0]).toBe(published[0])
  expect(atlas.successorStatus(root)).toBe('complete')
  expect(updates).toEqual([0, 1, 2])
})

test('transition properties check valid undefined Messages', () => {
  const checked: Array<undefined> = []
  const atlas = make<number, undefined, number>(
    {
      name: 'Undefined Message',
      Model: Schema.Number,
      Message: Schema.Undefined,
      start: input => ({ model: input }),
      update: (model: number) => ({ model }),
      view: (_model, h) => h.div([]),
    },
    {
      *starts() {
        return 0
      },
      *next() {
        return move(undefined)
      },
    },
    {
      properties: [
        {
          name: 'The transition is rejected',
          transition: (_before, message) => {
            checked.push(message)
            return false
          },
        },
      ],
    },
  )
  const failures = atlas.check(1)
  expect(checked).toEqual([undefined])
  expect(failures).toHaveLength(1)
  expect(failures[0]?.property).toBe('The transition is rejected')
  expect(failures[0]?.trace).toHaveLength(2)
})
