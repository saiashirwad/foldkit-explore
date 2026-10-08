import { Array, Equal } from 'effect'

import type { Property } from '../lab/atlas'
import type { Message, Model } from './main'

export const properties: ReadonlyArray<Property<Model, Message>> = [
  {
    name: 'At most one account creation is pending',
    state: ({ pending }) =>
      Array.filter(pending, command => command.name === 'CreateAccount')
        .length <= 1,
  },
  {
    name: 'An answer for another username leaves the Model unchanged',
    transition: (before, message, after) =>
      message._tag !== 'CompletedCheckUsername' ||
      message.username === before.model.username ||
      Equal.equals(before.model, after.model),
  },
  {
    name: 'Submitting creates the displayed account',
    transition: (before, message, after) =>
      message._tag !== 'SubmittedSignup' ||
      before.model.step._tag !== 'Confirm' ||
      (after.model.step._tag === 'Creating' &&
        Array.some(
          after.pending,
          command =>
            command.name === 'CreateAccount' &&
            command.args?.username === before.model.username &&
            command.args?.plan === before.model.plan,
        )),
  },
  {
    name: 'A taken account returns to Account with Taken availability',
    transition: (_before, message, after) =>
      message._tag !== 'FailedCreateAccount' ||
      message.reason !== 'Taken' ||
      (after.model.step._tag === 'Account' &&
        after.model.availability._tag === 'Taken'),
  },
]
