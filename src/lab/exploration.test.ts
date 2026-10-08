import { Array, Option, Schema } from 'effect'
import { expect, test } from 'vitest'

import * as Signup from '../signup/main'
import { SignupCases } from '../signup/main.cases'
import { properties } from '../signup/properties'
import { type Atlas, type Schedule, make } from './atlas'
import { fixture } from './fixture'

const signup = (schedule: Schedule = 'any') =>
  make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule,
    properties,
  })
const start = (atlas: Atlas) =>
  Option.getOrThrow(Array.head(atlas.reach(0).states))
const send = (atlas: Atlas, state: string, message: Signup.Message) =>
  Option.getOrThrow(atlas.send(state, message))
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

test('any scheduler removes the chosen command and replays its address in a fresh atlas', () => {
  const atlas = signup()
  const checking = checkingTwice(atlas)
  const newestFirst = answer(atlas, checking, 'CheckUsername #2 free')
  expect(atlas.pending(newestFirst)).toEqual([
    { name: 'CheckUsername', args: '{"username":"ada"}' },
  ])
  expect(atlas.encode(newestFirst)).toMatchObject({
    username: 'grace',
    availability: { _tag: 'Free' },
  })
  const staleLast = answer(atlas, newestFirst, 'CheckUsername #1 taken')
  expect(atlas.encode(staleLast)).toEqual(atlas.encode(newestFirst))
  expect(atlas.pending(staleLast)).toEqual([])
  const fresh = signup()
  const resolved = Option.getOrThrow(fresh.resolve(atlas.address(newestFirst)))
  expect(fresh.encode(resolved)).toEqual(atlas.encode(newestFirst))
  expect(fresh.pending(resolved)).toEqual(atlas.pending(newestFirst))
})

test('oldest scheduling keeps the historical restriction and stale-first handling', () => {
  const atlas = signup('oldest')
  const checking = checkingTwice(atlas)
  expect(
    atlas.successors(checking).filter(step => step.kind === 'Answer'),
  ).toHaveLength(2)
  const staleFirst = answer(atlas, checking, 'CheckUsername taken')
  expect(atlas.encode(staleFirst)).toEqual(atlas.encode(checking))
  expect(atlas.pending(staleFirst)).toEqual([
    { name: 'CheckUsername', args: '{"username":"grace"}' },
  ])
  const latest = answer(atlas, staleFirst, 'CheckUsername free')
  expect(atlas.encode(latest)).toMatchObject({ availability: { _tag: 'Free' } })
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
  expect(atlas.reach(8).isComplete).toBe(false)
  expect(atlas.groups(atlas.reach(8).states).length).toBeLessThan(
    atlas.reach(8).states.length,
  )
})

const counter = () =>
  make({
    name: 'Counter',
    Model: Schema.Number,
    Message: Schema.Number,
    update: (_model, message) => ({ model: message }),
    view: (_model, h) => h.div([]),
    *cases() {
      return {
        model: 0,
        *moves(model: number) {
          return yield* fixture(
            'move',
            model === 0
              ? { long: 1, short: 3 }
              : model === 1
                ? { onwards: 2 }
                : model === 2 || model === 3
                  ? { finish: 4 }
                  : {},
          )
        },
      }
    },
    properties: [
      { name: 'state', state: ({ model }) => model !== 4 },
      { name: 'transition', transition: (_before, message) => message !== 4 },
    ],
  })

test('counterexamples use shortest explored paths, not earlier live-event discovery', () => {
  const atlas = counter()
  const root = start(atlas)
  const one = Option.getOrThrow(atlas.send(root, 1))
  const two = Option.getOrThrow(atlas.send(one, 2))
  const three = Option.getOrThrow(atlas.send(two, 4))
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
