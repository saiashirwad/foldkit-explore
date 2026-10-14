import { Array, Schema } from 'effect'
import { Runtime } from 'foldkit'

import { type Environment, type Program, make, send } from './atlas'
import { fixture } from './fixture'
import { makeLab } from './lab'
import { makeComparisonCase } from './review'

const program: Program<number, number> = {
  name: 'Browser finite counter',
  Model: Schema.Number,
  Message: Schema.Number,
  start: () => ({ model: 0 }),
  update: (_model, message) => ({ model: message }),
  view: (model, h) =>
    h.section(
      [],
      [
        h.h1([], [model === 0 ? 'Start' : 'Before heading']),
        h.button([h.OnClick(1)], ['Continue']),
      ],
    ),
}
const finite: Environment<number, number> = {
  *starts() {},
  *next(state) {
    return send(yield* fixture('event', state.model === 0 ? { next: 1 } : {}))
  },
}
const pruned: Environment<number, number> = {
  *starts() {
    for (const axis of Array.range(1, 20)) {
      yield* fixture(`axis${axis}`, { a: 0, b: 1 })
    }
    return yield* fixture('pruned', {})
  },
}
const lab = makeLab(
  [
    make({ ...program, name: 'Browser slow search' }, pruned),
    make(program, finite),
  ],
  [
    makeComparisonCase('Browser slow comparison', {
      before: program,
      after: program,
      environment: pruned,
      limits: { depth: 8, states: 100, transitions: 100 },
    }),
    makeComparisonCase('Browser changed heading', {
      before: program,
      after: {
        ...program,
        view: (model, h) =>
          h.section(
            [],
            [
              h.h1([], [model === 0 ? 'Start' : 'After heading']),
              h.button([h.OnClick(1)], ['Continue']),
            ],
          ),
      },
      environment: finite,
      limits: { depth: 8, states: 100, transitions: 100 },
    }),
  ],
)

Runtime.run(
  Runtime.makeApplication({
    ...lab,
    container: document.getElementById('root'),
    devTools: false,
  }),
)
