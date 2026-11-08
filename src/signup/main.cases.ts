import {
  type Choices,
  type Environment,
  type Move,
  type State,
  answer,
  fixture,
  pendingRequests,
  send,
} from '../explore'
import {
  CheckUsername,
  CreateAccount,
  Message,
  type Model,
  type Plan,
  Step,
} from './main'

// NOTE: These are the controls each step renders.
const userMoves = (model: Model): Readonly<Record<string, Message>> =>
  Step.match(model.step, {
    Account: () => ({
      typedNothing: Message.UpdatedUsername({ value: '' }),
      typedAda: Message.UpdatedUsername({ value: 'ada' }),
      typedGrace: Message.UpdatedUsername({ value: 'grace' }),
      next: Message.ClickedNext(),
    }),
    Profile: () => ({
      back: Message.ClickedBack(),
      free: Message.SelectedPlan({ plan: 'Free' }),
      pro: Message.SelectedPlan({ plan: 'Pro' }),
      next: Message.ClickedNext(),
    }),
    Confirm: () => ({
      back: Message.ClickedBack(),
      submit: Message.SubmittedSignup(),
    }),
    Creating: () => ({}),
    Created: () => ({}),
    Failed: () => ({ retry: Message.ClickedRetry() }),
  })

function* next(state: State<Model, Message, Plan>): Choices<Move<Message>> {
  const kind = yield* fixture('next', {
    user: 'user',
    check: 'check',
    create: 'create',
  })
  if (kind === 'user') {
    return send(yield* fixture('move', userMoves(state.model)))
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

function* SignupStarts(): Choices<Plan> {
  return yield* fixture('arrivedFrom', { home: 'Free', pricing: 'Pro' })
}

export const signupEnvironment: Environment<Model, Message, Plan> = {
  starts: SignupStarts,
  next,
}
