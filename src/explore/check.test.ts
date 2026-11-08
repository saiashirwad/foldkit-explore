import { Effect } from 'effect'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { expect, test } from 'vitest'

import { deadEnds, find, neverSent, tagsOf, violations } from './check'
import { type Choices, fixture } from './choices'
import {
  type Environment,
  type Move,
  type Program,
  type State,
  answer,
  explore,
  pendingRequests,
  send,
} from './explore'

// A button starts a load. The buggy version shows the spinner but never asks
// for the data.

const Message = defineMessageUnion({ ClickedLoad: {}, Loaded: {} })
type Message = typeof Message.Type
type Model = Readonly<{ status: 'idle' | 'loading' | 'done' }>

const Load = Command.define('Load', {
  args: {},
  messages: [Message.Loaded],
  execute: () => Effect.succeed(Message.Loaded()),
})

const makeProgram = (isBuggy: boolean): Program<Model, Message> => ({
  name: 'Loader',
  Message,
  start: (): Update.Return<Model, Message> => ({ model: { status: 'idle' } }),
  update: (_model, message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(message, {
      ClickedLoad: () =>
        isBuggy
          ? { model: { status: 'loading' } }
          : { model: { status: 'loading' }, commands: [Load({})] },
      Loaded: () => ({ model: { status: 'done' } }),
    }),
  view: (model, h) => h.p([], [model.status]),
})

function* next(state: State<Model, Message>): Choices<Move<Message>> {
  const kind = yield* fixture('next', { user: 'user', reply: 'reply' })
  if (kind === 'user') {
    return send(
      yield* fixture(
        'move',
        state.model.status === 'idle' ? { load: Message.ClickedLoad() } : {},
      ),
    )
  }
  return answer(
    yield* fixture('pending', pendingRequests(state, Load)),
    Message.Loaded(),
  )
}

const environment: Environment<Model, Message> = { *starts() {}, next }
const limits = { depth: 4, states: 100 }

const hasSpinnerWork = (state: State<Model, Message>): boolean =>
  state.model.status !== 'loading' || state.pending.length > 0

test('a spinner with nothing pending is found with its shortest path', () => {
  const graph = explore(makeProgram(true), environment, limits)
  expect(violations(graph, hasSpinnerWork).map(found => found.path)).toEqual([
    ['', 'user · load'],
  ])
})

test('a correct loader has no violations and no way to get stuck', () => {
  const graph = explore(makeProgram(false), environment, limits)
  expect(violations(graph, hasSpinnerWork)).toEqual([])
  // Only the finished state has no way out, and it is a fine place to end.
  expect(deadEnds(graph, limits.depth).map(found => found.id)).toEqual([2])
})

test('the buggy loader strands the spinner', () => {
  const graph = explore(makeProgram(true), environment, limits)
  expect(
    deadEnds(graph, limits.depth).map(
      found => graph.nodes[found.id]?.model.status,
    ),
  ).toEqual(['loading'])
})

test('a state at the depth limit is not a dead end', () => {
  const graph = explore(makeProgram(false), environment, {
    depth: 1,
    states: 9,
  })
  expect(deadEnds(graph, 1)).toEqual([])
})

test('find returns the shortest path to the first matching state', () => {
  const result = find(
    makeProgram(false),
    environment,
    ({ model }) => model.status === 'done',
    limits,
  )
  expect(result.found?.path).toEqual(['', 'user · load', 'reply · 0'])
  expect(result.found?.model).toEqual({ status: 'done' })
})

test('find says whether a miss covers everything reachable', () => {
  const result = find(makeProgram(false), environment, () => false, limits)
  expect(result).toEqual({ found: undefined, isComplete: true })
})

test('neverSent lists the declared Messages no move sent', () => {
  expect(tagsOf(Message)).toEqual(['ClickedLoad', 'Loaded'])
  const graph = explore(makeProgram(true), environment, limits)
  expect(neverSent(graph, tagsOf(Message))).toEqual(['Loaded'])
  expect(
    neverSent(
      explore(makeProgram(false), environment, limits),
      tagsOf(Message),
    ),
  ).toEqual([])
})
