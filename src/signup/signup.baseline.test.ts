import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

import {
  decodeSnapshot,
  diffSnapshots,
  formatFindings,
  snapshotOf,
} from '../explore'
import { expectBaseline } from '../explore/baseline-vitest'
import { signupEnvironment } from './main.cases'
import { headingChanged, helperRefactor, original } from './variants'

// The committed record of Signup's states. A change to any screen or move
// fails here with the differences. After an intended change, run
// `UPDATE_BASELINE=1 bun run test` and review the baseline's diff.
test('Signup still matches its committed baseline', () => {
  expectBaseline(
    'src/signup/signup.states.json',
    snapshotOf(original, signupEnvironment, { depth: 5, states: 3_000 }),
  )
})

const committed = () =>
  decodeSnapshot(readFileSync('src/signup/signup.states.json', 'utf8'))

test('the baseline catches a changed heading', () => {
  const report = formatFindings(
    diffSnapshots(
      committed(),
      snapshotOf(headingChanged, signupEnvironment, committed().limits),
    ),
  )
  expect(report).toContain('now: Review your account')
})

test('the baseline ignores an equivalent refactor', () => {
  expect(
    diffSnapshots(
      committed(),
      snapshotOf(helperRefactor, signupEnvironment, committed().limits),
    ).findings,
  ).toEqual([])
})
