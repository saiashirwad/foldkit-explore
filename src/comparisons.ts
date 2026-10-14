import { Array } from 'effect'

import { compare } from './lab/compare'
import type { ComparisonCase } from './lab/review'
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
  after => ({
    name: after === original ? 'Identical versions' : after.name,
    run: depth =>
      compare({
        before: original,
        after,
        environment: signupEnvironment,
        properties,
        limits: { depth, states: 5_000, transitions: 20_000 },
      }),
  }),
)
