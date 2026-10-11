import { Array, Option } from 'effect'
import { expect, test } from 'vitest'

import { make } from '../lab/atlas'
import {
  type Comparison,
  type ComparisonFinding,
  compare,
} from '../lab/compare'
import { Message } from './main'
import { signupEnvironment } from './main.cases'
import { properties } from './properties'
import {
  duplicateSubmissions,
  headingChanged,
  helperRefactor,
  original,
  retryRemoved,
  staleResponses,
} from './variants'

const comparison = (after: typeof original): Comparison =>
  compare({
    before: original,
    after,
    environment: signupEnvironment,
    properties,
    limits: { depth: 8, states: 5_000, transitions: 20_000 },
  })

const findingOf = (
  result: Comparison,
  predicate: (finding: ComparisonFinding) => boolean,
): ComparisonFinding =>
  Option.getOrThrow(Array.findFirst(result.findings, predicate))

test(
  'identical Signup versions and an equivalent helper refactor have no differences',
  { timeout: 20_000 },
  () => {
    expect(comparison(original).findings).toEqual([])
    expect(comparison(helperRefactor).findings).toEqual([])
  },
)

test(
  'a confirmation heading edit is grouped as content while all events still match',
  { timeout: 20_000 },
  () => {
    const result = comparison(headingChanged)
    const heading = findingOf(
      result,
      finding =>
        finding.kind === 'content' && finding.after === 'Review your account',
    )
    expect(heading.before).toBe('Sign up')
    expect(heading.examples.length).toBeGreaterThan(1)
    expect(heading.shortest.depth).toBe(4)
    expect(result.findings.every(finding => finding.kind === 'content')).toBe(
      true,
    )
    expect(result.replay(heading.shortest.trace)).toHaveLength(
      heading.shortest.trace.length,
    )
  },
)

test(
  'removing Retry produces a short trace through an Unavailable response with both error previews',
  { timeout: 20_000 },
  () => {
    const result = comparison(retryRemoved)
    const retry = findingOf(
      result,
      finding =>
        finding.kind === 'action-removed' &&
        finding.title.includes('Try again'),
    )
    expect(retry.shortest.depth).toBe(6)
    expect(
      retry.shortest.before?.observation.actions.some(
        action => action.label === 'click Try again',
      ),
    ).toBe(true)
    expect(
      retry.shortest.after?.observation.actions.some(
        action => action.label === 'click Try again',
      ),
    ).toBe(false)
    expect(retry.shortest.trace.at(-1)?.afterEvent?.message).toEqual(
      Message.FailedCreateAccount({ reason: 'Unavailable' }),
    )
    expect(retry.examples.length).toBeGreaterThan(1)
    expect(retry.shortest.depth).toBe(
      Math.min(...retry.examples.map(example => example.depth)),
    )
    const replay = result.replay(retry.shortest.trace)
    expect(replay.at(-1)?.before?.model).toEqual(retry.shortest.before?.model)
    expect(replay.at(-1)?.after?.model).toEqual(retry.shortest.after?.model)
  },
)

test(
  'removing the stale-response guard changes observed behavior and fails only the candidate property',
  { timeout: 20_000 },
  () => {
    const result = comparison(staleResponses)
    const failures = result.propertyFailures.filter(
      failure =>
        failure.property ===
        'An answer for another username leaves the Model unchanged',
    )
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.every(failure => failure.side === 'after')).toBe(true)
    expect(result.findings.some(finding => finding.kind === 'content')).toBe(
      true,
    )
    const first = failures[0]
    expect(first?.example.trace.at(-1)?.afterEvent?.message).toMatchObject({
      _tag: 'CompletedCheckUsername',
    })
    if (first !== undefined) {
      expect(result.replay(first.example.trace).at(-1)?.after?.model).toEqual(
        first.example.after?.model,
      )
    }
  },
)

test(
  'an extra submit has real one-sided evidence of two pending creations and a property failure',
  { timeout: 20_000 },
  () => {
    const result = comparison(duplicateSubmissions)
    const failure = Option.getOrThrow(
      Array.findFirst(
        result.propertyFailures,
        failure =>
          failure.side === 'after' &&
          failure.property === 'At most one account creation is pending',
      ),
    )
    expect(
      failure.example.after?.pending.filter(
        command => command.name === 'CreateAccount',
      ),
    ).toHaveLength(2)
    expect(failure.example.before).toBeUndefined()
    expect(failure.example.trace.at(-1)?.afterEvent?.message).toEqual(
      Message.SubmittedSignup(),
    )
    expect(
      result.findings.some(finding => finding.kind === 'action-added'),
    ).toBe(true)
    const replay = result.replay(failure.example.trace)
    expect(replay.at(-1)?.before).toBeUndefined()
    expect(replay.at(-1)?.after?.pending).toEqual(
      failure.example.after?.pending,
    )
  },
)

test(
  'comparison owns its evidence independently of earlier live exploration',
  { timeout: 20_000 },
  () => {
    const atlas = make(original, signupEnvironment)
    const start = Option.getOrThrow(Array.head(atlas.reach(0).states))
    atlas.interact(
      start,
      Message.UpdatedUsername({ value: 'unmodeled-live-input' }),
    )
    const first = comparison(headingChanged)
    const fresh = comparison(headingChanged)
    expect(
      first.findings.map(finding => [
        finding.kind,
        finding.before,
        finding.after,
        finding.shortest.trace,
      ]),
    ).toEqual(
      fresh.findings.map(finding => [
        finding.kind,
        finding.before,
        finding.after,
        finding.shortest.trace,
      ]),
    )
  },
)
