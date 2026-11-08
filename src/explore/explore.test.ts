import { Array, Effect, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { expect, test } from 'vitest'

import { type Choices, fixture } from './choices'
import {
  type Environment,
  type Graph,
  type Move,
  type Program,
  type State,
  answer,
  defaultKey,
  explore,
  pendingRequests,
  send,
} from './explore'
import { keyOf } from './key'

// A counter that can also save its value; saving is a pending Command.

const Message = defineMessageUnion({
  Incremented: {},
  ClickedSave: {},
  Saved: {},
})
type Message = typeof Message.Type
type Model = Readonly<{ count: number; saved: boolean }>

const Save = Command.define('Save', {
  args: { count: Schema.Number },
  messages: [Message.Saved],
  execute: () => Effect.succeed(Message.Saved()),
})

const program: Program<Model, Message, number> = {
  name: 'Counter',
  Message,
  start: (count): Update.Return<Model, Message> => ({
    model: { count, saved: false },
  }),
  update: (model, message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(message, {
      Incremented: () => ({ model: { ...model, count: model.count + 1 } }),
      ClickedSave: () => ({
        model: model,
        commands: [Save({ count: model.count })],
      }),
      Saved: () => ({ model: { ...model, saved: true } }),
    }),
  view: (model, h) => h.div([], [`${model.count}`]),
}

function* next(state: State<Model, Message, number>): Choices<Move<Message>> {
  const kind = yield* fixture('next', { user: 'user', reply: 'reply' })
  if (kind === 'user') {
    return send(
      yield* fixture('move', {
        increment: Message.Incremented(),
        save: Message.ClickedSave(),
      }),
    )
  }
  const request = yield* fixture('pending', pendingRequests(state, Save))
  return answer(request, Message.Saved())
}

const environment: Environment<Model, Message, number> = {
  starts: function* () {
    return yield* fixture('start', { zero: 0 })
  },
  next,
}

const counts = (graph: Graph<Model, Message, number>) =>
  Array.map(graph.nodes, node => node.model.count)

test('explores breadth first and merges equal states', () => {
  const graph = explore(program, environment, { depth: 2, states: 100 })
  expect(counts(graph)).toEqual([0, 1, 0, 2, 1, 1, 0, 0])
  expect(graph.nodes.map(node => node.depth)).toEqual([0, 1, 1, 2, 2, 2, 2, 2])
})

test('an answer consumes only its Command', () => {
  const graph = explore(program, environment, { depth: 2, states: 100 })
  const saved = graph.nodes.find(node => node.model.saved)
  expect(saved?.pending).toEqual([])
})

test('reports an incomplete search', () => {
  expect(
    explore(program, environment, { depth: 1, states: 100 }).isComplete,
  ).toBe(false)
  expect(
    explore(program, environment, { depth: 3, states: 3 }).isComplete,
  ).toBe(false)
})

test('prune drops states and show only hides them', () => {
  const pruned = explore(
    program,
    { ...environment, prune: ({ model }) => model.count > 1 },
    { depth: 3, states: 100 },
  )
  expect(Math.max(...counts(pruned))).toBe(1)

  const hidden = explore(
    program,
    { ...environment, show: ({ model }) => model.count !== 1 },
    { depth: 3, states: 100 },
  )
  expect(hidden.nodes.some(node => node.model.count === 2)).toBe(true)
  expect(hidden.nodes.filter(node => node.shown)).not.toContainEqual(
    expect.objectContaining({ model: { count: 1, saved: false } }),
  )
})

test('a key merges states that differ only in what it ignores', () => {
  const merged = explore(
    program,
    { ...environment, key: ({ model }) => model.count },
    { depth: 3, states: 100 },
  )
  expect(counts(merged)).toEqual([0, 1, 2, 3])
})

test('excluded keys behave like pruned states', () => {
  const full = explore(program, environment, { depth: 2, states: 100 })
  const [, second] = full.nodes
  const without = explore(program, environment, {
    depth: 2,
    states: 100,
    exclude: new Set(second ? [second.key] : []),
  })
  expect(without.nodes.length).toBeLessThan(full.nodes.length)
})

test('the exported prune rule matches excluding the same states', () => {
  const full = explore(program, environment, { depth: 2, states: 100 })
  const second = full.nodes[1]
  const pruned = new Set(second ? [second.key] : [])
  const byRule = explore(
    program,
    { ...environment, prune: state => pruned.has(keyOf(defaultKey(state))) },
    { depth: 2, states: 100 },
  )
  const byExclude = explore(program, environment, {
    depth: 2,
    states: 100,
    exclude: pruned,
  })
  expect(byRule.nodes.map(node => node.key)).toEqual(
    byExclude.nodes.map(node => node.key),
  )
})
