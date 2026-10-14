import { Array, Equal } from 'effect'

import type { Property } from '../lab/atlas'
import type { Message, Model } from './main'

export const properties: ReadonlyArray<Property<Model, Message>> = [
  {
    id: 'at-most-one-account-creation-is-pending',
    name: 'At most one account creation is pending',
    state: ({ pending }) =>
      Array.filter(pending, command => command.name === 'CreateAccount')
        .length <= 1,
  },
  {
    id: 'an-answer-for-another-username-leaves-the-model-unchanged',
    name: 'An answer for another username leaves the Model unchanged',
    transitionApplies: (before, message) =>
      message._tag === 'CompletedCheckUsername' &&
      message.username !== before.model.username,
    transition: (before, _message, after) =>
      Equal.equals(before.model, after.model),
  },
  {
    id: 'submitting-creates-the-displayed-account',
    name: 'Submitting creates the displayed account',
    transitionApplies: (before, message) =>
      message._tag === 'SubmittedSignup' &&
      before.model.step._tag === 'Confirm',
    transition: (before, _message, after, evidence) =>
      after.model.step._tag === 'Creating' &&
      Array.some(
        evidence.issued,
        command =>
          command.name === 'CreateAccount' &&
          command.args?.username === before.model.username &&
          command.args?.plan === before.model.plan,
      ),
  },
  {
    id: 'a-taken-account-returns-to-account-with-taken-availability',
    name: 'A taken account returns to Account with Taken availability',
    transitionApplies: (_before, message) =>
      message._tag === 'FailedCreateAccount' && message.reason === 'Taken',
    transition: (_before, _message, after) =>
      after.model.step._tag === 'Account' &&
      after.model.availability._tag === 'Taken',
  },
]
