import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { type Atlas, answer, make, pendingRequests, send } from './atlas'
import { type ReplayIdentity } from './evidence'
import { fixture } from './fixture'

const EvidenceReadValue = Command.define('EvidenceReadValue', {
  args: { value: Schema.Number },
  messages: [Schema.Number],
  execute: () =>
    Effect.die('Evidence replay must not execute Command effects.'),
})
const Model = Schema.Struct({
  count: Schema.Number,
  maybeValue: Schema.Option(Schema.Unknown),
})
type Model = typeof Model.Type

export const evidenceIdentity: ReplayIdentity = {
  program: 'evidence-counter@1',
  environment: 'two-duplicate-replies@1',
  inputEncoding: 'foldkit-data/v1',
  modelEncoding: 'evidence-counter-model@1',
  messageEncoding: 'number@1',
}

type FixtureOptions = Readonly<{
  initialCommand?: number
  issuedCommand?: number
  selectedIndex?: number
  message?: number
  inputExtra?: string
  text?: string
}>

export const evidenceFixture = (options: FixtureOptions = {}): Atlas => {
  const context = Object.defineProperty({}, 'mode', {
    value: options.inputExtra ?? 'original',
  })
  const setup = {
    negativeZero: -0,
    present: undefined,
    maybeValue: Option.some({
      value: undefined,
      maybeMissing: Option.none(),
      nan: NaN,
      large: 42n,
    }),
    context,
  }
  return make(
    {
      name: 'Portable evidence fixture',
      Model,
      Message: Schema.Number,
      start: (input: typeof setup) => {
        const duplicate = EvidenceReadValue({
          value: options.initialCommand ?? -0,
        })
        return {
          model: {
            count: input.negativeZero,
            maybeValue: input.maybeValue,
          },
          commands: [duplicate, duplicate],
        }
      },
      update: (model: Model, message) => ({
        model: {
          count: message,
          maybeValue: model.maybeValue,
        },
        commands: [EvidenceReadValue({ value: options.issuedCommand ?? 99 })],
      }),
      view: (model, h) => h.div([], [options.text ?? String(model.count)]),
    },
    {
      *starts() {
        return yield* fixture('seed', { chosen: setup })
      },
      *next(state) {
        if (Object.is(state.model.count, -0)) {
          const requests = pendingRequests(state, EvidenceReadValue)
          const request = yield* fixture('request', {
            first: requests['0'],
            second: requests[String(options.selectedIndex ?? 1)],
          })
          if (request === undefined) {
            throw new Error(
              'The evidence fixture did not select a pending request.',
            )
          }
          return answer(request, options.message ?? 1)
        }
        return send(
          yield* fixture('move', state.model.count === 1 ? { finish: 2 } : {}),
        )
      },
    },
    {
      properties: [
        {
          id: 'nonnegative',
          name: 'Nonnegative',
          state: state => state.model.count >= 0,
        },
      ],
    },
  )
}
