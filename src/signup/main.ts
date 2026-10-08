import { Array, Effect, Match, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

// MODEL

export const Plan = Schema.Literals(['Free', 'Pro'])
export type Plan = typeof Plan.Type

export const Availability = defineTaggedUnion({
  Unchecked: {},
  Checking: {},
  Taken: {},
  Free: {},
})
export type Availability = typeof Availability.Type

export const Step = defineTaggedUnion({
  Account: {},
  Profile: {},
  Confirm: {},
  Creating: {},
  Created: { accountId: Schema.String },
  Failed: {},
})
export type Step = typeof Step.Type

export const Model = Schema.Struct({
  step: Step,
  username: Schema.String,
  availability: Availability,
  plan: Plan,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedUsername: { value: Schema.String },
  CompletedCheckUsername: { username: Schema.String, isTaken: Schema.Boolean },
  ClickedNext: {},
  ClickedBack: {},
  SelectedPlan: { plan: Plan },
  SubmittedSignup: {},
  ClickedRetry: {},
  SucceededCreateAccount: { accountId: Schema.String },
  FailedCreateAccount: { reason: Schema.Literals(['Taken', 'Unavailable']) },
})
export type Message = typeof Message.Type

// COMMAND

export const CheckUsername = Command.define('CheckUsername', {
  args: { username: Schema.String },
  messages: [Message.CompletedCheckUsername],
  execute: ({ username }) =>
    Effect.succeed(Message.CompletedCheckUsername({ username, isTaken: true })),
})

export const CreateAccount = Command.define('CreateAccount', {
  args: { username: Schema.String, plan: Plan },
  messages: [Message.SucceededCreateAccount, Message.FailedCreateAccount],
  execute: () =>
    Effect.succeed(Message.FailedCreateAccount({ reason: 'Unavailable' })),
})

// INIT

export const init = (plan: Plan): Update.Return<Model, Message> => ({
  model: {
    step: Step.Account(),
    username: '',
    availability: Availability.Unchecked(),
    plan,
  },
})

// UPDATE

const updateUsername = (
  model: Model,
  value: string,
): Update.Return<Model, Message> => {
  if (value === model.username) {
    return { model }
  }
  if (value === '') {
    return {
      model: modifyFields(model, {
        username: () => value,
        availability: () => Availability.Unchecked(),
      }),
    }
  }
  return {
    model: modifyFields(model, {
      username: () => value,
      availability: () => Availability.Checking(),
    }),
    commands: [CheckUsername({ username: value })],
  }
}

const createAccount = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, { step: () => Step.Creating() }),
  commands: [CreateAccount({ username: model.username, plan: model.plan })],
})

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedUsername: ({ value }) => updateUsername(model, value),
    CompletedCheckUsername: ({ username, isTaken }) => {
      if (username !== model.username) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          availability: () =>
            isTaken ? Availability.Taken() : Availability.Free(),
        }),
      }
    },
    ClickedNext: () => ({
      model: modifyFields(model, {
        step: step =>
          Match.value(step).pipe(
            Match.tag('Account', () =>
              model.availability._tag === 'Free' ? Step.Profile() : step,
            ),
            Match.tag('Profile', () => Step.Confirm()),
            Match.orElse(() => step),
          ),
      }),
    }),
    ClickedBack: () => ({
      model: modifyFields(model, {
        step: step =>
          Match.value(step).pipe(
            Match.tag('Profile', () => Step.Account()),
            Match.tag('Confirm', () => Step.Profile()),
            Match.orElse(() => step),
          ),
      }),
    }),
    SelectedPlan: ({ plan }) => ({
      model: modifyFields(model, { plan: () => plan }),
    }),
    SubmittedSignup: () =>
      model.step._tag === 'Confirm' ? createAccount(model) : { model },
    ClickedRetry: () =>
      model.step._tag === 'Failed' ? createAccount(model) : { model },
    SucceededCreateAccount: ({ accountId }) => ({
      model: modifyFields(model, { step: () => Step.Created({ accountId }) }),
    }),
    FailedCreateAccount: ({ reason }) => ({
      model:
        reason === 'Taken'
          ? modifyFields(model, {
              step: () => Step.Account(),
              availability: () => Availability.Taken(),
            })
          : modifyFields(model, { step: () => Step.Failed() }),
    }),
  })

// VIEW

const primaryButton =
  'h-9 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none'

const secondaryButton =
  'h-9 rounded-lg px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-100'

const steps: ReadonlyArray<string> = ['Account', 'Profile', 'Confirm']

const stepIndex = (step: Step): number =>
  Step.match(step, {
    Account: () => 0,
    Profile: () => 1,
    Confirm: () => 2,
    Creating: () => 2,
    Created: () => 3,
    Failed: () => 2,
  })

const progressView = (step: Step, h: HtmlBuilder<Message>): Html =>
  h.ol(
    [h.Class('flex gap-1.5')],
    Array.map(steps, (name, index) =>
      h.keyed('li')(
        name,
        [
          h.AriaCurrent(index === stepIndex(step) ? 'step' : 'false'),
          h.Class(
            `flex-1 border-t-2 pt-1.5 text-[11px] font-medium ${
              index <= stepIndex(step)
                ? 'border-violet-500 text-violet-700'
                : 'border-slate-200 text-slate-400'
            }`,
          ),
        ],
        [`${index + 1}. ${name}`],
      ),
    ),
  )

const availabilityView = (
  availability: Availability,
  h: HtmlBuilder<Message>,
): Html =>
  h.p(
    [h.Role('status'), h.Class('min-h-4 text-xs')],
    [
      Availability.match(availability, {
        Unchecked: () => h.span([h.Class('text-slate-400')], ['Pick a name']),
        Checking: () =>
          h.span([h.Class('animate-pulse text-slate-500')], ['Checking…']),
        Taken: () => h.span([h.Class('text-rose-600')], ['That name is taken']),
        Free: () => h.span([h.Class('text-emerald-600')], ['✓ Available']),
      }),
    ],
  )

const accountView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class('flex flex-col gap-2'), h.OnSubmit(Message.ClickedNext())],
    [
      h.label(
        [
          h.Class(
            'flex flex-col gap-1.5 text-[13px] font-medium text-slate-700',
          ),
        ],
        [
          'Username',
          h.input([
            h.Value(model.username),
            h.Autocomplete('username'),
            h.AriaInvalid(model.availability._tag === 'Taken'),
            h.OnInput(value => Message.UpdatedUsername({ value })),
            h.Class(
              'h-9 rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm font-normal focus:border-violet-400 focus:ring-2 focus:ring-violet-100 focus:outline-none',
            ),
          ]),
        ],
      ),
      availabilityView(model.availability, h),
      h.div(
        [h.Class('flex justify-end')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Class(primaryButton),
              h.Disabled(model.availability._tag !== 'Free'),
            ],
            ['Next'],
          ),
        ],
      ),
    ],
  )

const planOption = (
  plan: Plan,
  detail: string,
  selected: Plan,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaPressed(plan === selected ? 'true' : 'false'),
      h.OnClick(Message.SelectedPlan({ plan })),
      h.Class(
        `flex flex-1 flex-col items-start rounded-xl p-3 text-left ring-1 ring-inset transition ${
          plan === selected
            ? 'bg-violet-50 ring-violet-400'
            : 'bg-white ring-slate-200 hover:bg-slate-50'
        }`,
      ),
    ],
    [
      h.span([h.Class('text-sm font-semibold text-slate-900')], [plan]),
      h.span([h.Class('text-xs text-slate-500')], [detail]),
    ],
  )

const navigation = (next: Html, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex justify-between')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(secondaryButton),
          h.OnClick(Message.ClickedBack()),
        ],
        ['Back'],
      ),
      next,
    ],
  )

const profileView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-3')],
    [
      h.div(
        [h.Class('flex gap-2')],
        [
          planOption('Free', '3 projects', model.plan, h),
          planOption('Pro', 'Unlimited, $8/mo', model.plan, h),
        ],
      ),
      navigation(
        h.button(
          [h.Class(primaryButton), h.OnClick(Message.ClickedNext())],
          ['Next'],
        ),
        h,
      ),
    ],
  )

const summaryView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.dl(
    [
      h.Class(
        'grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-slate-50 p-3 text-[13px] ring-1 ring-inset ring-slate-200/70',
      ),
    ],
    [
      h.dt([h.Class('text-slate-500')], ['Username']),
      h.dd([h.Class('font-mono text-slate-900')], [model.username]),
      h.dt([h.Class('text-slate-500')], ['Plan']),
      h.dd([h.Class('text-slate-900')], [model.plan]),
    ],
  )

const confirmView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class('flex flex-col gap-3'), h.OnSubmit(Message.SubmittedSignup())],
    [
      summaryView(model, h),
      navigation(
        h.button(
          [h.Type('submit'), h.Class(primaryButton)],
          ['Create account'],
        ),
        h,
      ),
    ],
  )

const creatingView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-3')],
    [
      summaryView(model, h),
      h.p(
        [
          h.Role('status'),
          h.Class(
            'grid h-9 place-items-center rounded-lg bg-violet-600/70 text-sm font-medium text-white',
          ),
        ],
        ['Creating account…'],
      ),
    ],
  )

const createdView = (
  model: Model,
  accountId: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.p(
    [
      h.Role('status'),
      h.Class(
        'rounded-lg bg-emerald-50 px-3 py-2.5 text-[13px] leading-snug text-emerald-800 ring-1 ring-inset ring-emerald-200/70',
      ),
    ],
    [
      `Welcome, ${model.username}! Account ${accountId} is on the ${model.plan} plan.`,
    ],
  )

const failedView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      summaryView(model, h),
      h.p(
        [
          h.Role('alert'),
          h.Class(
            'rounded-lg bg-rose-50 px-3 py-2.5 text-[13px] leading-snug text-rose-800 ring-1 ring-inset ring-rose-200/70',
          ),
        ],
        ['Signup service unavailable. No account was created.'],
      ),
      h.button(
        [h.Class(primaryButton), h.OnClick(Message.ClickedRetry())],
        ['Try again'],
      ),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex w-full flex-col gap-4 bg-white p-5')],
    [
      h.h3(
        [
          h.Class(
            'text-[11px] font-medium tracking-wider text-slate-400 uppercase',
          ),
        ],
        ['Sign up'],
      ),
      progressView(model.step, h),
      Step.match(model.step, {
        Account: () => accountView(model, h),
        Profile: () => profileView(model, h),
        Confirm: () => confirmView(model, h),
        Creating: () => creatingView(model, h),
        Created: ({ accountId }) => createdView(model, accountId, h),
        Failed: () => failedView(model, h),
      }),
    ],
  )
