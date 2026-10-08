import { Array, Effect, Match, Option, Schema } from 'effect'
import { AsyncData, Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

// MODEL

export const Check = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(['Passed', 'Running', 'Failed']),
  detail: Schema.String,
})
export type Check = typeof Check.Type

export const Approval = defineTaggedUnion({
  Pending: {},
  Rejected: {},
  Approved: { approvedBy: Schema.String },
})

export const Target = defineTaggedUnion({
  Staging: {},
  Production: { approval: Approval },
})
export type Target = typeof Target.Type

export const Release = Schema.Struct({
  service: Schema.String,
  title: Schema.String,
  commit: Schema.String,
  revision: Schema.Number,
  target: Target,
  checks: Schema.Array(Check),
  access: Schema.Literals(['Viewer', 'Deployer']),
})
export type Release = typeof Release.Type

export const ReleaseData = AsyncData.Schema(Release, Schema.String)

export const Submission = defineTaggedUnion({
  Reviewing: {},
  Confirming: { confirmation: Schema.String },
  Submitting: {},
  Queued: { deploymentId: Schema.String },
  Conflicted: {},
  Lost: {},
  Failed: {},
})
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  release: ReleaseData.schema,
  submission: Submission,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchRelease: { release: Release },
  FailedFetchRelease: { error: Schema.String },
  ClickedReview: {},
  UpdatedConfirmation: { value: Schema.String },
  ClickedCancel: {},
  SubmittedDeployment: {},
  ClickedRetry: {},
  SucceededDeployRelease: { deploymentId: Schema.String },
  FailedDeployRelease: {
    reason: Schema.Literals(['Conflict', 'Unavailable', 'Disconnected']),
  },
})
export type Message = typeof Message.Type

// DOMAIN

const environmentOf = (release: Release) =>
  Target.match(release.target, {
    Staging: () => 'staging',
    Production: () => 'production',
  })

export const blockerOf = (release: Release): Option.Option<string> =>
  Match.value(release).pipe(
    Match.when(
      ({ checks }) => Array.some(checks, check => check.status === 'Failed'),
      () => 'Fix the failed checks before deploying.',
    ),
    Match.when(
      ({ checks }) => Array.some(checks, check => check.status === 'Running'),
      () => 'Waiting for all checks to pass.',
    ),
    Match.when(
      { access: 'Viewer' },
      () => 'You have read-only access. Ask a deployer to release this build.',
    ),
    Match.when(
      { target: { _tag: 'Production', approval: { _tag: 'Pending' } } },
      () => 'Waiting for approval from a production reviewer.',
    ),
    Match.when(
      { target: { _tag: 'Production', approval: { _tag: 'Rejected' } } },
      () => 'Production approval was rejected. Address the review feedback.',
    ),
    Match.option,
  )

const isConfirmed = (release: Release, confirmation: string) =>
  environmentOf(release) === 'staging' || confirmation === 'production'

// COMMAND

export const FetchRelease = Command.define('FetchRelease', {
  messages: [Message.SucceededFetchRelease, Message.FailedFetchRelease],
  execute: Effect.succeed(
    Message.FailedFetchRelease({ error: 'This demo has no release service.' }),
  ),
})

export const DeployRelease = Command.define('DeployRelease', {
  args: {
    commit: Schema.String,
    environment: Schema.String,
    expectedRevision: Schema.Number,
  },
  messages: [Message.SucceededDeployRelease, Message.FailedDeployRelease],
  execute: () =>
    Effect.succeed(Message.FailedDeployRelease({ reason: 'Unavailable' })),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: {
    release: ReleaseData.Loading(),
    submission: Submission.Reviewing(),
  },
  commands: [FetchRelease()],
})

// UPDATE

const submit = (model: Model): Update.Return<Model, Message> => {
  if (
    !AsyncData.isSuccess(model.release) ||
    model.submission._tag !== 'Confirming' ||
    Option.isSome(blockerOf(model.release.data)) ||
    !isConfirmed(model.release.data, model.submission.confirmation)
  ) {
    return { model }
  }
  const release = model.release.data
  return {
    model: modifyFields(model, { submission: () => Submission.Submitting() }),
    commands: [
      DeployRelease({
        commit: release.commit,
        environment: environmentOf(release),
        expectedRevision: release.revision,
      }),
    ],
  }
}

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededFetchRelease: ({ release }) => ({
      model: modifyFields(model, {
        release: () => ReleaseData.Success({ data: release }),
      }),
    }),
    FailedFetchRelease: ({ error }) => ({
      model: modifyFields(model, {
        release: () => ReleaseData.Failure({ error }),
      }),
    }),
    ClickedReview: () => ({
      model: modifyFields(model, {
        submission: () => Submission.Confirming({ confirmation: '' }),
      }),
    }),
    UpdatedConfirmation: ({ value }) => ({
      model: modifyFields(model, {
        submission: submission =>
          submission._tag === 'Confirming'
            ? Submission.Confirming({ confirmation: value })
            : submission,
      }),
    }),
    ClickedCancel: () => ({
      model: modifyFields(model, {
        submission: () => Submission.Reviewing(),
      }),
    }),
    SubmittedDeployment: () => submit(model),
    ClickedRetry: () => ({
      model: modifyFields(model, {
        submission: () => Submission.Confirming({ confirmation: '' }),
      }),
    }),
    SucceededDeployRelease: ({ deploymentId }) => ({
      model: modifyFields(model, {
        submission: () => Submission.Queued({ deploymentId }),
      }),
    }),
    FailedDeployRelease: ({ reason }) => ({
      model: modifyFields(model, {
        submission: () =>
          Match.value(reason).pipe(
            Match.when('Conflict', () => Submission.Conflicted()),
            Match.when('Unavailable', () => Submission.Failed()),
            Match.when('Disconnected', () => Submission.Lost()),
            Match.exhaustive,
          ),
      }),
    }),
  })

// VIEW

const primaryButton =
  'h-9 w-full rounded-lg bg-violet-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none'

const secondaryButton =
  'h-9 rounded-lg px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-100'

const notice = (
  tone: 'Neutral' | 'Success' | 'Error',
  text: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.p(
    [
      h.Role(tone === 'Error' ? 'alert' : 'status'),
      h.Class(
        `rounded-lg px-3 py-2.5 text-[13px] leading-snug ring-1 ring-inset ${Match.value(
          tone,
        ).pipe(
          Match.when(
            'Neutral',
            () => 'bg-slate-50 text-slate-600 ring-slate-200/70',
          ),
          Match.when(
            'Success',
            () => 'bg-emerald-50 text-emerald-800 ring-emerald-200/70',
          ),
          Match.when(
            'Error',
            () => 'bg-rose-50 text-rose-800 ring-rose-200/70',
          ),
          Match.exhaustive,
        )}`,
      ),
    ],
    [text],
  )

const statusIcon = (status: Check['status'], h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(
        `grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${Match.value(
          status,
        ).pipe(
          Match.when('Passed', () => 'bg-emerald-50 text-emerald-600'),
          Match.when(
            'Running',
            () => 'animate-pulse bg-amber-50 text-amber-500',
          ),
          Match.when('Failed', () => 'bg-rose-50 text-rose-600'),
          Match.exhaustive,
        )}`,
      ),
    ],
    [
      Match.value(status).pipe(
        Match.when('Passed', () => '✓'),
        Match.when('Running', () => '•'),
        Match.when('Failed', () => '✕'),
        Match.exhaustive,
      ),
    ],
  )

const checkView = (check: Check, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    check.name,
    [h.Class('flex items-center gap-3 py-2.5')],
    [
      statusIcon(check.status, h),
      h.div(
        [h.Class('min-w-0')],
        [
          h.p(
            [h.Class('text-[13px] font-medium text-slate-900')],
            [check.name],
          ),
          h.p([h.Class('truncate text-xs text-slate-500')], [check.detail]),
        ],
      ),
    ],
  )

const environmentBadge = (release: Release, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(
        `rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${Target.match(
          release.target,
          {
            Staging: () => 'bg-sky-50 text-sky-700 ring-sky-200/70',
            Production: () => 'bg-amber-50 text-amber-800 ring-amber-200/70',
          },
        )}`,
      ),
    ],
    [environmentOf(release)],
  )

const confirmationView = (
  release: Release,
  confirmation: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.Class(
        'flex flex-col gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-200/70',
      ),
      h.OnSubmit(Message.SubmittedDeployment()),
    ],
    [
      h.p(
        [h.Class('text-[13px] leading-snug text-slate-700')],
        [
          environmentOf(release) === 'production'
            ? `This changes the live ${release.service} service. Type production to confirm.`
            : 'Deploy this commit to staging?',
        ],
      ),
      environmentOf(release) === 'production'
        ? h.input([
            h.AriaLabel('Confirm environment'),
            h.Placeholder('production'),
            h.Value(confirmation),
            h.OnInput(value => Message.UpdatedConfirmation({ value })),
            h.Class(
              'h-9 rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100 focus:outline-none',
            ),
          ])
        : h.empty,
      h.div(
        [h.Class('flex justify-end gap-1')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(secondaryButton),
              h.OnClick(Message.ClickedCancel()),
            ],
            ['Cancel'],
          ),
          h.button(
            [
              h.Type('submit'),
              h.Class(`${primaryButton} w-auto`),
              h.Disabled(!isConfirmed(release, confirmation)),
            ],
            [`Deploy to ${environmentOf(release)}`],
          ),
        ],
      ),
    ],
  )

const submissionView = (
  release: Release,
  submission: Submission,
  h: HtmlBuilder<Message>,
): Html =>
  Submission.match(submission, {
    Reviewing: () =>
      h.button(
        [h.Class(primaryButton), h.OnClick(Message.ClickedReview())],
        ['Review deployment'],
      ),
    Confirming: ({ confirmation }) =>
      confirmationView(release, confirmation, h),
    Submitting: () =>
      h.p(
        [
          h.Role('status'),
          h.Class(
            'grid h-9 place-items-center rounded-lg bg-violet-600/70 text-sm font-medium text-white',
          ),
        ],
        ['Deploying…'],
      ),
    Queued: ({ deploymentId }) =>
      notice(
        'Success',
        `Deployment ${deploymentId} queued for ${environmentOf(release)}.`,
        h,
      ),
    Conflicted: () =>
      notice(
        'Error',
        'A newer commit replaced this release. Refresh before trying again.',
        h,
      ),
    Lost: () =>
      notice(
        'Error',
        'Connection lost. Check deployment history before trying again.',
        h,
      ),
    Failed: () =>
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          notice(
            'Error',
            'Deployment service unavailable. Nothing was deployed.',
            h,
          ),
          h.button(
            [h.Class(primaryButton), h.OnClick(Message.ClickedRetry())],
            ['Try again'],
          ),
        ],
      ),
  })

const approvalView = (release: Release, h: HtmlBuilder<Message>): Html =>
  release.target._tag === 'Production' &&
  release.target.approval._tag === 'Approved'
    ? h.p(
        [h.Class('text-xs text-emerald-700')],
        [`✓ Approved by ${release.target.approval.approvedBy}`],
      )
    : h.empty

const releaseView = (
  release: Release,
  submission: Submission,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.div(
    [],
    [
      h.h4(
        [h.Class('text-[15px] font-semibold tracking-tight text-slate-900')],
        [release.title],
      ),
      h.p(
        [h.Class('mt-0.5 font-mono text-xs text-slate-500')],
        [`${release.service} · ${release.commit}`],
      ),
    ],
  ),
  h.ul(
    [h.Class('divide-y divide-slate-100 border-y border-slate-100')],
    Array.map(release.checks, check => checkView(check, h)),
  ),
  Option.match(blockerOf(release), {
    onSome: blocker =>
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          notice('Neutral', blocker, h),
          h.button(
            [h.Class(primaryButton), h.Disabled(true)],
            [`Deploy to ${environmentOf(release)}`],
          ),
        ],
      ),
    onNone: () =>
      h.div(
        [h.Class('flex flex-col gap-2')],
        [approvalView(release, h), submissionView(release, submission, h)],
      ),
  }),
]

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex w-full flex-col gap-4 bg-white p-5')],
    [
      h.div(
        [h.Class('flex items-center justify-between')],
        [
          h.h3(
            [
              h.Class(
                'text-[11px] font-medium tracking-wider text-slate-400 uppercase',
              ),
            ],
            ['Release'],
          ),
          AsyncData.isSuccess(model.release)
            ? environmentBadge(model.release.data, h)
            : h.empty,
        ],
      ),
      ...AsyncData.matchDataSplitEmpty(model.release, {
        onIdle: () => [],
        onLoading: () => [
          h.p(
            [h.Role('status'), h.Class('text-[13px] text-slate-500')],
            ['Loading release and checks…'],
          ),
        ],
        onFailure: error => [notice('Error', error, h)],
        onData: release => releaseView(release, model.submission, h),
      }),
    ],
  )
