import { type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { expect, test } from 'vitest'

import { type Choices, fixture } from './choices'
import { compare } from './compare'
import {
  type Environment,
  type Move,
  type Program,
  type State,
  send,
} from './explore'

const Message = defineMessageUnion({ Incremented: {}, Reset: {} })
type Message = typeof Message.Type
type Model = Readonly<{ count: number }>

const original: Program<Model, Message> = {
  name: 'Counter',
  Message,
  start: (): Update.Return<Model, Message> => ({ model: { count: 0 } }),
  update: (model, message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(message, {
      Incremented: () => ({ model: { count: model.count + 1 } }),
      Reset: () => ({ model: { count: 0 } }),
    }),
  view: (model, h) => h.p([], [`Count: ${model.count}`]),
}

// Reset is only offered once there is something to reset.
function* next(state: State<Model, Message>): Choices<Move<Message>> {
  return send(
    yield* fixture('move', {
      increment: Message.Incremented(),
      ...(state.model.count > 0 ? { reset: Message.Reset() } : {}),
    }),
  )
}

const environment: Environment<Model, Message> = {
  *starts() {},
  next,
}

const limits = { depth: 3, states: 100 }

test('identical versions have no findings', () => {
  const result = compare(original, original, environment, limits)
  expect(result.findings).toEqual([])
  expect(result.pairs).toBeGreaterThan(1)
})

test('a changed view is one grouped finding with its shortest path', () => {
  const result = compare(
    original,
    { ...original, view: (model, h) => h.p([], [`Total: ${model.count}`]) },
    environment,
    limits,
  )
  const screens = result.findings.filter(finding => finding.kind === 'screen')
  expect(screens.map(finding => finding.before)).toEqual([
    'Count: 0',
    'Count: 1',
    'Count: 2',
    'Count: 3',
  ])
  expect(screens[0]).toMatchObject({
    after: 'Total: 0',
    count: 1,
    path: [''],
    states: { before: { count: 0 }, after: { count: 0 } },
  })
})

test('a move only one version offers is reported', () => {
  const result = compare(
    original,
    {
      ...original,
      update: (model, message) =>
        message._tag === 'Incremented'
          ? { model }
          : original.update(model, message),
    },
    environment,
    limits,
  )
  expect(result.findings).toContainEqual(
    expect.objectContaining({ kind: 'only-before', before: 'reset' }),
  )
})

test('is incomplete when a limit cuts a side short', () => {
  expect(
    compare(original, original, environment, { depth: 1, states: 100 }),
  ).toMatchObject({ isComplete: false })
})
