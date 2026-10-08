import { Array, Schema } from 'effect'
import type { Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { expect, test } from 'vitest'

import { release, weather } from '../programs'
import { type PendingCommand, describe, make } from './atlas'
import { fixture } from './fixture'

const isDeploy = ({ name }: PendingCommand) => name === 'DeployRelease'

test('every weather state', async () => {
  await expect(describe(weather, 8)).toMatchFileSnapshot('weather.atlas')
})

test('every release state', async () => {
  await expect(describe(release, 12)).toMatchFileSnapshot('release.atlas')
})

test('a release is never deployed twice at once', () => {
  const doubleDeploys = Array.filter(
    release.reach(12).states,
    state => Array.filter(release.pending(state), isDeploy).length > 1,
  )
  expect(doubleDeploys).toEqual([])
})

test('a viewer never starts a deployment', () => {
  const viewerDeploys = Array.filter(
    release.reach(12).states,
    state =>
      Array.some(release.trace(state), step =>
        Array.some(step.decisions, decision => decision.option === 'viewer'),
      ) && Array.some(release.pending(state), isDeploy),
  )
  expect(viewerDeploys).toEqual([])
})

const Item = Schema.Struct({ id: Schema.Number, done: Schema.Boolean })
const Checklist = Schema.Struct({
  items: Schema.Array(Item),
  cursor: Schema.Number,
})
type Checklist = typeof Checklist.Type
const ChecklistMessage = defineMessageUnion({
  ToggledItem: {},
  MovedCursor: {},
})
type ChecklistMessage = typeof ChecklistMessage.Type

const checklist = make<Checklist, ChecklistMessage>({
  name: 'Checklist',
  Model: Checklist,
  Message: ChecklistMessage,
  update: (model, message) =>
    ChecklistMessage.match<Update.Return<Checklist, ChecklistMessage>>(
      message,
      {
        ToggledItem: () => ({
          model: modifyFields(model, {
            items: items =>
              Array.map(items, (item, index) =>
                index === model.cursor
                  ? modifyFields(item, { done: done => !done })
                  : item,
              ),
          }),
        }),
        MovedCursor: () => ({
          model: modifyFields(model, { cursor: cursor => (cursor + 1) % 4 }),
        }),
      },
    ),
  view: (_model, h) => h.div([]),
  *cases() {
    return {
      model: {
        items: Array.makeBy(10_000, id => ({ id, done: false })),
        cursor: 0,
      },
      *moves() {
        return yield* fixture('move', {
          toggled: ChecklistMessage.ToggledItem(),
          moved: ChecklistMessage.MovedCursor(),
        })
      },
    }
  },
})

test('states of a large Model share everything a step leaves unchanged', () => {
  const { states, isComplete } = checklist.reach(20)
  expect(isComplete).toBe(true)
  expect(states.length).toBe(64)
  expect(checklist.nodes()).toBeLessThan(10_000 + 64 * 4)
})
