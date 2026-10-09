import { Array, Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import { expect, test } from 'vitest'

import * as Weather from '../main'
import { WeatherCases } from '../main.cases'
import {
  type Atlas,
  type NextState,
  type Transition,
  answer,
  make,
  pendingRequests,
  send,
} from './atlas'
import { type Choices, fixture } from './fixture'

const ReadValue = Command.define('ReadValue', {
  args: { value: Schema.Number },
  messages: [Schema.Number],
  execute: () => Effect.die('Exploration must not execute Commands'),
})
const Other = Command.define('Other', {
  messages: [Schema.Number],
  execute: Effect.die('Exploration must not execute Commands'),
})

type Next = (state: NextState<number, number>) => Choices<Transition<number>>

const start = (atlas: Atlas) =>
  Option.getOrThrow(Array.head(atlas.reach(0).states))
const counter = (next: Next) =>
  make({
    name: 'Counter',
    Model: Schema.Number,
    Message: Schema.Number,
    update: (_model, message) => ({ model: message }),
    view: (_model, h) => h.div([]),
    *cases() {
      const repeated = ReadValue({ value: 10 })
      return {
        model: 0,
        commands: [repeated, Other(), ReadValue({ value: 20 }), repeated],
        next,
      }
    },
  })

function* replies(
  state: NextState<number, number>,
): Choices<Transition<number>> {
  const request = yield* fixture('pending', pendingRequests(state, ReadValue))
  return answer(request, request.command.args.value)
}

test('next consumes the chosen occurrence, including identical Command references, and replays it', () => {
  const atlas = counter(replies)
  const steps = atlas.successors(start(atlas))
  expect(steps.map(step => step.decisions)).toEqual([
    [{ fixture: 'pending', option: '0' }],
    [{ fixture: 'pending', option: '2' }],
    [{ fixture: 'pending', option: '3' }],
  ])
  const last = Option.getOrThrow(Array.last(steps)).to
  expect(atlas.pending(last)).toEqual([
    { name: 'ReadValue', args: '{"value":10}' },
    { name: 'Other', args: '{}' },
    { name: 'ReadValue', args: '{"value":20}' },
  ])
  expect(atlas.encode(last)).toBe(10)
  expect(steps[0]?.to).not.toBe(last)
  const fresh = counter(replies)
  const replayed = Option.getOrThrow(fresh.resolve(atlas.address(last)))
  expect(fresh.pending(replayed)).toEqual(atlas.pending(last))
  expect(fresh.encode(replayed)).toEqual(atlas.encode(last))
})

test('a scheduling restriction is ordinary choice construction in next', () => {
  const atlas = counter(function* (state) {
    const oldest = Object.fromEntries(
      Array.take(Object.entries(pendingRequests(state, ReadValue)), 1),
    )
    const request = yield* fixture('pending', oldest)
    return answer(request, request.command.args.value)
  })
  const steps = atlas.successors(start(atlas))
  expect(steps).toHaveLength(1)
  expect(steps[0]?.decisions).toEqual([{ fixture: 'pending', option: '0' }])
})

test('an answer cannot consume a Command outside the source state', () => {
  const atlas = counter(function* () {
    return answer({ index: 0, command: ReadValue({ value: 10 }) }, 10)
  })
  expect(() => atlas.successors(start(atlas))).toThrow(
    'answer must select a pending Command from this state',
  )
})

test('an answer cannot consume an invalid position', () => {
  const atlas = counter(function* (state) {
    const request = yield* fixture('pending', pendingRequests(state, ReadValue))
    return answer({ index: 99, command: request.command }, 10)
  })
  expect(() => atlas.successors(start(atlas))).toThrow(
    'answer must select a pending Command from this state',
  )
})

test('equal Models with different next functions remain different execution states', () => {
  const first: Next = function* () {
    return send(1)
  }
  const second: Next = function* () {
    return send(2)
  }
  const atlas = make({
    name: 'Different behavior',
    Model: Schema.Number,
    Message: Schema.Number,
    update: (_model, message) => ({ model: message }),
    view: (_model, h) => h.div([]),
    *cases() {
      const next = yield* fixture('behavior', { first, second })
      return { model: 0, next }
    },
  })
  const starts = atlas.reach(0).states
  expect(starts).toHaveLength(2)
  expect(
    starts.map(state =>
      atlas.successors(state).map(step => atlas.encode(step.to)),
    ),
  ).toEqual([[1], [2]])
})

const weather = () =>
  make({
    name: 'Weather',
    Model: Weather.Model,
    Message: Weather.Message,
    update: Weather.update,
    view: (model, h) => Weather.view(model, h).body,
    cases: WeatherCases,
  })

const choose = (atlas: Atlas, state: string, option: string) =>
  Option.getOrThrow(
    Array.findFirst(atlas.successors(state), step =>
      Array.some(step.decisions, decision => decision.option === option),
    ),
  )

test('empty pending choices prune only the response branch; early answers skip later fixtures', () => {
  const atlas = weather()
  const idle = start(atlas)
  expect(atlas.successors(idle).map(step => step.kind)).toEqual([
    'Move',
    'Move',
    'Move',
  ])
  const loading = choose(atlas, idle, 'submitted').to
  const answers = atlas
    .successors(loading)
    .filter(step => step.kind === 'Answer')
  expect(answers).toHaveLength(1)
  expect(answers[0]?.decisions).toEqual([
    { fixture: 'next', option: 'response' },
    { fixture: 'pending', option: '0' },
  ])
  const valid = choose(atlas, idle, 'typed').to
  const validLoading = choose(atlas, valid, 'submitted').to
  expect(
    atlas
      .successors(validLoading)
      .filter(step => step.kind === 'Answer')
      .map(step => step.decisions.at(-1)),
  ).toEqual([
    { fixture: 'result', option: 'succeeded' },
    { fixture: 'result', option: 'failed' },
  ])
})

test('next explores user actions before and after a response, without preselecting a scenario', () => {
  const atlas = weather()
  const valid = choose(atlas, start(atlas), 'typed').to
  const loading = choose(atlas, valid, 'submitted').to
  const clearedFirst = choose(atlas, loading, 'cleared').to
  const succeededAfterClear = choose(atlas, clearedFirst, 'succeeded').to
  const succeededFirst = choose(atlas, loading, 'succeeded').to
  const clearedAfterSuccess = choose(atlas, succeededFirst, 'cleared').to
  expect(succeededAfterClear).toBe(clearedAfterSuccess)
  expect(atlas.encode(succeededAfterClear)).toMatchObject({
    zipCodeInput: '',
    weather: { _tag: 'Success' },
  })
  expect(atlas.pending(clearedFirst)).toEqual([
    { name: 'FetchWeather', args: '{"zipCode":"90210"}' },
  ])
})

test('view interactions are a choice source, not a second exploration path', () => {
  const atlas = make({
    name: 'Mixed interactions',
    Model: Schema.Number,
    Message: Schema.Number,
    update: (_model, message) => ({ model: message }),
    view: (_model, h) => h.button([h.OnClick(2)], ['Two']),
    *cases() {
      return {
        model: 0,
        inputs: [],
        *next(state: NextState<number, number>) {
          const source = yield* fixture('source', {
            explicit: 'explicit',
            view: 'view',
            ignored: 'ignored',
          })
          if (source === 'explicit') {
            return send(1)
          }
          if (source === 'ignored') {
            return send(yield* fixture<number>('none', {}))
          }
          return send(yield* fixture('interaction', state.interactions))
        },
      }
    },
  })
  const steps = atlas.successors(start(atlas))
  expect(steps.map(step => atlas.encode(step.to))).toEqual([1, 2])
  expect(steps.map(step => step.decisions)).toEqual([
    [{ fixture: 'source', option: 'explicit' }],
    [
      { fixture: 'source', option: 'view' },
      { fixture: 'interaction', option: '0: click Two' },
    ],
  ])
})

test('next validates Messages against the program schema before applying update', () => {
  const atlas = make({
    name: 'Integer Messages',
    Model: Schema.Number,
    Message: Schema.Int,
    update: (_model, message) => ({ model: message }),
    view: (_model, h) => h.div([]),
    *cases() {
      return {
        model: 0,
        *next() {
          return send(0.5)
        },
      }
    },
  })
  expect(() => atlas.successors(start(atlas))).toThrow(
    'next returned an invalid Message',
  )
})
