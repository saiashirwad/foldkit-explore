import {
  type Environment,
  type NextState,
  type Transition,
  answer,
  pendingRequests,
  send,
} from '../lab/atlas'
import { type Choices, fixture } from '../lab/fixture'
import {
  CheckUsername,
  CreateAccount,
  Message,
  type Model,
  type Plan,
} from './main'

function* next(state: NextState<Model, Message>): Choices<Transition<Message>> {
  const kind = yield* fixture('next', {
    user: 'user',
    check: 'check',
    create: 'create',
  })
  if (kind === 'user') {
    return send(yield* fixture('interaction', state.interactions))
  }
  if (kind === 'check') {
    const request = yield* fixture(
      'pending',
      pendingRequests(state, CheckUsername),
    )
    const { username } = request.command.args
    const message = yield* fixture('name', {
      free: Message.CompletedCheckUsername({ username, isTaken: false }),
      taken: Message.CompletedCheckUsername({ username, isTaken: true }),
    })
    return answer(request, message)
  }
  const request = yield* fixture(
    'pending',
    pendingRequests(state, CreateAccount),
  )
  return answer(
    request,
    yield* fixture('create', {
      created: Message.SucceededCreateAccount({ accountId: 'acc_7' }),
      taken: Message.FailedCreateAccount({ reason: 'Taken' }),
      unavailable: Message.FailedCreateAccount({ reason: 'Unavailable' }),
    }),
  )
}

export const longUsername =
  'averylongunbrokenusernameforcheckinghowaccountdetailswraponnarrowdisplays'

export function* SignupStarts(): Choices<Plan> {
  return yield* fixture('arrivedFrom', { home: 'Free', pricing: 'Pro' })
}

export const signupEnvironment: Environment<Model, Message, Plan> = {
  starts: SignupStarts,
  inputs: [{ label: 'Username', values: ['', 'ada', 'grace'] }],
  next,
}

export const signupLongContentEnvironment: Environment<Model, Message, Plan> = {
  starts: SignupStarts,
  inputs: [{ label: 'Username', values: [longUsername] }],
  next,
}
