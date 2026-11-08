import { expect, test } from 'vitest'

import { compare } from '../explore'
import { signupEnvironment } from './main.cases'
import {
  headingChanged,
  helperRefactor,
  original,
  retryRemoved,
  staleResponses,
} from './variants'

const limits = { depth: 7, states: 3_000 }
const kinds = (after: typeof original) =>
  compare(original, after, signupEnvironment, limits).findings.map(
    finding => finding.kind,
  )

test('an equivalent refactor has no findings', () => {
  expect(kinds(helperRefactor)).toEqual([])
})

test('a changed heading shows as a screen difference', () => {
  expect(kinds(headingChanged)).toContain('screen')
})

test('a removed retry button shows as a screen difference', () => {
  expect(kinds(retryRemoved)).toContain('screen')
})

test('removing the stale response guard changes the states reached', () => {
  expect(kinds(staleResponses).length).toBeGreaterThan(0)
})
