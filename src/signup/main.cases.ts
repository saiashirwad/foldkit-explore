import { modifyFields } from 'foldkit/struct'

import { type Setup, respond } from '../lab/atlas'
import { type Choices, fixture } from '../lab/fixture'
import { CheckUsername, CreateAccount, Message, type Model, init } from './main'

const responders = [
  respond(CheckUsername, function* ({ username }) {
    return yield* fixture('name', {
      free: Message.CompletedCheckUsername({ username, isTaken: false }),
      taken: Message.CompletedCheckUsername({ username, isTaken: true }),
    })
  }),
  respond(CreateAccount, function* () {
    return yield* fixture('create', {
      created: Message.SucceededCreateAccount({ accountId: 'acc_7' }),
      taken: Message.FailedCreateAccount({ reason: 'Taken' }),
      unavailable: Message.FailedCreateAccount({ reason: 'Unavailable' }),
    })
  }),
]

export const longUsername =
  'averylongunbrokenusernameforcheckinghowaccountdetailswraponnarrowdisplays'

export function* SignupLongContentCases(): Choices<Setup<Model, Message>> {
  const setup = yield* SignupCases()
  return modifyFields(setup, {
    inputs: () => [{ label: 'Username', values: [longUsername] }],
  })
}

export function* SignupCases(): Choices<Setup<Model, Message>> {
  const plan = yield* fixture('arrivedFrom', { home: 'Free', pricing: 'Pro' })
  return {
    ...init(plan),
    inputs: [{ label: 'Username', values: ['', 'ada', 'grace'] }],
    responders,
  }
}
