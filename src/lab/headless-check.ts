import { Schema } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'

import { signupProgram } from '../programs'
import { signupEnvironment } from '../signup/main.cases'
import { properties } from '../signup/properties'
import { type Environment, make, send } from './atlas'
import { checkDecision } from './check-policy'
import { encodeEvidenceData } from './evidence-data'
import { fixture } from './fixture'

const Scenario = Schema.Literals([
  'safe',
  'counterexample',
  'incomplete',
  'error',
  'empty',
  'signup',
])

export const runHeadlessCheck = (scenario: string, depth?: number) => {
  const selected = Schema.decodeUnknownSync(Scenario)(scenario)
  const program = {
    name: 'CI finite counter',
    Model: Schema.Number,
    Message: Schema.Number,
    start: () => ({ model: 0 }),
    update: (_model: number, message: number) => ({ model: message }),
    view: (model: number, h: HtmlBuilder<number>) => h.p([], [String(model)]),
  }
  const environment: Environment<number, number> = {
    *starts() {
      if (selected === 'empty') {
        return yield* fixture('empty', {})
      }
    },
    *next(state) {
      if (selected === 'error') {
        throw new Error('Injected environment failure')
      }
      return send(
        yield* fixture(
          'move',
          state.model < 2 ? { next: state.model + 1, stay: state.model } : {},
        ),
      )
    },
  }
  const atlas =
    selected === 'signup'
      ? make(signupProgram, signupEnvironment, { properties })
      : make(program, environment, {
          properties: [
            {
              id: 'safe',
              name: 'Finite safety',
              state: state =>
                selected !== 'counterexample' || state.model !== 2,
            },
          ],
        })
  try {
    const report = atlas.check(
      depth ?? (selected === 'incomplete' ? 0 : selected === 'signup' ? 8 : 4),
    )
    return {
      version: 1,
      scenario: selected,
      decision: checkDecision(report),
      coverage: report.coverage.reached,
      properties: report.properties.map(property => ({
        id: property.id,
        verdict: property.verdict,
        counts: property.counts,
      })),
      reportEncoding: 'foldkit-execution-data-v1',
      report: encodeEvidenceData(report),
    }
  } finally {
    atlas.dispose()
  }
}
