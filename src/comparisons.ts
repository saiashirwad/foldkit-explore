import { Array } from 'effect'

import { type ComparisonCase, makeComparisonCase } from './lab/review'
import { signupEnvironment } from './programs'
import { properties } from './signup/properties'
import {
  duplicateSubmissions,
  headingChanged,
  helperRefactor,
  original,
  retryRemoved,
  staleResponses,
} from './signup/variants'

export const comparisons: ReadonlyArray<ComparisonCase> = Array.map(
  [
    retryRemoved,
    headingChanged,
    staleResponses,
    duplicateSubmissions,
    helperRefactor,
    original,
  ],
  after =>
    makeComparisonCase(after === original ? 'Identical versions' : after.name, {
      before: original,
      after,
      environment: signupEnvironment,
      properties,
      limits: { depth: 8, states: 5_000, transitions: 20_000 },
    }),
)
