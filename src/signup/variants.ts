import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { Program } from '../lab/atlas'
import * as Signup from './main'

type SignupProgram = Program<Signup.Model, Signup.Message, Signup.Plan>

export const original: SignupProgram = {
  name: 'Signup',
  Model: Signup.Model,
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

const unavailableView = (
  model: Signup.Model,
  h: HtmlBuilder<Signup.Message>,
): Html =>
  model.step._tag === 'Failed'
    ? Signup.frameView(
        model,
        'Sign up',
        h.div(
          [h.Class('flex flex-col gap-2')],
          [
            Signup.summaryView(model, h),
            h.p(
              [
                h.Role('alert'),
                h.Class(
                  'rounded-lg bg-rose-50 px-3 py-2.5 text-[13px] leading-snug text-rose-800 ring-1 ring-inset ring-rose-200/70',
                ),
              ],
              ['Signup service unavailable. No account was created.'],
            ),
          ],
        ),
        h,
      )
    : Signup.view(model, h)

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

const repeatUpdate = (
  model: Signup.Model,
  message: Signup.Message,
): Update.Return<Signup.Model, Signup.Message> =>
  model.step._tag === 'Creating' && message._tag === 'SubmittedSignup'
    ? {
        model,
        commands: [
          Signup.CreateAccount({ username: model.username, plan: model.plan }),
        ],
      }
    : Signup.update(model, message)

const repeatView = (
  model: Signup.Model,
  h: HtmlBuilder<Signup.Message>,
): Html =>
  model.step._tag === 'Creating'
    ? Signup.frameView(
        model,
        'Sign up',
        h.div(
          [h.Class('flex flex-col gap-3')],
          [
            Signup.creatingView(model, h),
            h.button(
              [
                h.Class(Signup.primaryButton),
                h.OnClick(Signup.Message.SubmittedSignup()),
              ],
              ['Create account again'],
            ),
          ],
        ),
        h,
      )
    : Signup.view(model, h)

const refactoredUpdate = (
  model: Signup.Model,
  message: Signup.Message,
): Update.Return<Signup.Model, Signup.Message> => Signup.update(model, message)

export const headingChanged = modifyFields(original, {
  name: () => 'Changed confirmation heading',
  view: () => headingView,
})

export const retryRemoved = modifyFields(original, {
  name: () => 'Retry removed',
  view: () => unavailableView,
})

export const staleResponses = modifyFields(original, {
  name: () => 'Stale response guard removed',
  update: () => unguardedUpdate,
})

export const duplicateSubmissions = modifyFields(original, {
  name: () => 'Duplicate submissions allowed',
  update: () => repeatUpdate,
  view: () => repeatView,
})

export const helperRefactor = modifyFields(original, {
  name: () => 'Equivalent helper refactor',
  update: () => refactoredUpdate,
})
