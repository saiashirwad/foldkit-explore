import { type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { expect, test } from 'vitest'

import {
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  formatFindings,
  snapshotOf,
} from './baseline'
import { type Choices, fixture } from './choices'
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

function* next(state: State<Model, Message>): Choices<Move<Message>> {
  return send(
    yield* fixture('move', {
      increment: Message.Incremented(),
      ...(state.model.count > 0 ? { reset: Message.Reset() } : {}),
    }),
  )
}

const environment: Environment<Model, Message> = { *starts() {}, next }
const limits = { depth: 3, states: 100 }
const baseline = snapshotOf(original, environment, limits)

test('a snapshot survives being written and read back', () => {
  expect(decodeSnapshot(encodeSnapshot(baseline))).toEqual(baseline)
})

test('the same code has nothing to report', () => {
  const again = snapshotOf(original, environment, limits)
  expect(formatFindings(diffSnapshots(baseline, again))).toBe('')
})

test('a changed screen is reported against the stored baseline', () => {
  const changed = snapshotOf(
    { ...original, view: (model, h) => h.p([], [`Total: ${model.count}`]) },
    environment,
    limits,
  )
  const report = formatFindings(diffSnapshots(baseline, changed))
  expect(report).toContain('screen ×1 at ')
  expect(report).toContain('was: Count: 1')
  expect(report).toContain('now: Total: 1')
})

test('a change the text hides is still reported', () => {
  const restyled = snapshotOf(
    {
      ...original,
      view: (model, h) => h.p([h.Class('bold')], [`Count: ${model.count}`]),
    },
    environment,
    limits,
  )
  expect(diffSnapshots(baseline, restyled).findings).not.toEqual([])
})

test('a removed move is reported', () => {
  const stuck = snapshotOf(
    { ...original, update: model => ({ model }) },
    environment,
    limits,
  )
  expect(formatFindings(diffSnapshots(baseline, stuck))).toContain(
    'only-before',
  )
})
