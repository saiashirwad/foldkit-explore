import { Array, Option } from 'effect'
import { AsyncData } from 'foldkit'

import { type Setup, respond } from '../lab/atlas'
import { type Choices, fixture } from '../lab/fixture'
import {
  Approval,
  type Check,
  DeployRelease,
  FetchRelease,
  Message,
  type Model,
  type Release,
  Submission,
  Target,
  blockerOf,
  init,
} from './main'

const passed: ReadonlyArray<Check> = [
  { name: 'Build', status: 'Passed', detail: 'Artifact uploaded' },
  { name: 'Typecheck', status: 'Passed', detail: 'No type errors' },
  { name: 'Integration tests', status: 'Passed', detail: '142 tests passed' },
]

function* releaseAnswer(): Choices<Message> {
  const isAvailable = yield* fixture('release', {
    ready: true,
    unavailable: false,
  })
  if (!isAvailable) {
    return Message.FailedFetchRelease({
      error: 'Release service unavailable. No deployment can be started.',
    })
  }
  const environment = yield* fixture('environment', {
    staging: 'staging',
    production: 'production',
  })
  const checks = yield* fixture('checks', {
    passed,
    running: Array.append(Array.take(passed, 2), {
      name: 'Integration tests',
      status: 'Running',
      detail: 'Running payment-provider tests',
    }),
    failed: Array.append(Array.take(passed, 2), {
      name: 'Integration tests',
      status: 'Failed',
      detail: 'Refund idempotency test failed',
    }),
  })
  const isChecked = Array.every(checks, check => check.status === 'Passed')
  const access = isChecked
    ? yield* fixture('access', { deployer: 'Deployer', viewer: 'Viewer' })
    : 'Deployer'
  const isApprovalRelevant =
    environment === 'production' && isChecked && access === 'Deployer'
  const approval = isApprovalRelevant
    ? yield* fixture('approval', {
        approved: Approval.Approved({ approvedBy: 'Maya Chen' }),
        pending: Approval.Pending(),
        rejected: Approval.Rejected(),
      })
    : Approval.Pending()
  const target =
    environment === 'staging'
      ? Target.Staging()
      : Target.Production({ approval })
  return Message.SucceededFetchRelease({
    release: {
      service: 'billing-api',
      title: 'Prevent duplicate invoice charges',
      commit: 'c73a9f2',
      revision: 42,
      target,
      checks,
      access,
    },
  })
}

function* deployAnswer(): Choices<Message> {
  return yield* fixture('deploy', {
    accepted: Message.SucceededDeployRelease({ deploymentId: 'dep_2048' }),
    conflict: Message.FailedDeployRelease({ reason: 'Conflict' }),
    unavailable: Message.FailedDeployRelease({ reason: 'Unavailable' }),
    disconnected: Message.FailedDeployRelease({ reason: 'Disconnected' }),
  })
}

const movesFor = (
  release: Release,
  submission: Submission,
): Readonly<Record<string, Message>> =>
  Submission.match(submission, {
    Reviewing: () => ({ reviewed: Message.ClickedReview() }),
    Confirming: () => ({
      ...(release.target._tag === 'Production'
        ? { confirmed: Message.UpdatedConfirmation({ value: 'production' }) }
        : {}),
      cancelled: Message.ClickedCancel(),
      submitted: Message.SubmittedDeployment(),
    }),
    Submitting: () => ({ submittedAgain: Message.SubmittedDeployment() }),
    Queued: () => ({}),
    Conflicted: () => ({}),
    Lost: () => ({}),
    Failed: () => ({ retried: Message.ClickedRetry() }),
  })

function* moves(model: Model): Choices<Message> {
  if (
    !AsyncData.isSuccess(model.release) ||
    Option.isSome(blockerOf(model.release.data))
  ) {
    return yield* fixture('move', {})
  }
  return yield* fixture('move', movesFor(model.release.data, model.submission))
}

const responders = [
  respond(FetchRelease, releaseAnswer),
  respond(DeployRelease, deployAnswer),
]

export function* ReleaseCases(): Choices<Setup<Model, Message>> {
  return { ...init(), moves, responders }
}
