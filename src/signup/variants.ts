import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { Program } from '../explore'
import * as Signup from './main'

type SignupProgram = Program<Signup.Model, Signup.Message, Signup.Plan>

export const original: SignupProgram = {
  name: 'Signup',
  Message: Signup.Message,
  start: Signup.init,
  update: Signup.update,
  view: Signup.view,
}

const headingView = (
  model: Signup.Model,
  h: HtmlBuilder<Signup.Message>,
): Html =>
  model.step._tag === 'Confirm'
    ? Signup.frameView(
        model,
        'Review your account',
        Signup.confirmView(model, h),
        h,
      )
    : Signup.view(model, h)

const retryRemovedView = (
  model: Signup.Model,
  h: HtmlBuilder<Signup.Message>,
): Html =>
  model.step._tag === 'Failed'
    ? Signup.frameView(model, 'Sign up', Signup.summaryView(model, h), h)
    : Signup.view(model, h)

// A late answer for an old username now overwrites the current one.
const unguardedUpdate = (
  model: Signup.Model,
  message: Signup.Message,
): Update.Return<Signup.Model, Signup.Message> =>
  message._tag === 'CompletedCheckUsername'
    ? {
        model: modifyFields(model, {
          availability: () =>
            message.isTaken
              ? Signup.Availability.Taken()
              : Signup.Availability.Free(),
        }),
      }
    : Signup.update(model, message)

export const headingChanged = modifyFields(original, {
  name: () => 'Changed confirmation heading',
  view: () => headingView,
})

export const retryRemoved = modifyFields(original, {
  name: () => 'Retry removed',
  view: () => retryRemovedView,
})

export const staleResponses = modifyFields(original, {
  name: () => 'Stale response guard removed',
  update: () => unguardedUpdate,
})

// Same behavior, written differently: expect no findings.
export const helperRefactor = modifyFields(original, {
  name: () => 'Equivalent refactor',
  update: () => (model, message) => Signup.update(model, message),
})
