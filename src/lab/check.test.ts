import { Option, Schema } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'
import { expect, test } from 'vitest'

import * as Signup from '../signup/main'
import { properties as signupProperties } from '../signup/properties'
import { type Environment, type Property, answer, make, send } from './atlas'
import { compare } from './compare'
import { fixture } from './fixture'

const program = {
  name: 'Checks',
  Model: Schema.Number,
  Message: Schema.Number,
  start: () => ({ model: 0 }),
  update: (_model: number, message: number) => ({ model: message }),
  view: (_model: number, h: HtmlBuilder<number>) => h.div([]),
}
const safe: Property<number, number> = {
  id: 'safe',
  name: 'Safe',
  state: () => true,
}
const closed: Environment<number, number> = {
  *starts() {
    return
  },
}
const branching: Environment<number, number> = {
  *starts() {
    return
  },
  *next({ model }) {
    return send(yield* fixture('move', model === 0 ? { one: 1, two: 2 } : {}))
  },
}

test('check reports distinguish empty, zero-budget, limited, complete, counterexample and errors', () => {
  const empty = make(
    program,
    {
      *starts() {
        return yield* fixture('empty', {})
      },
    },
    { properties: [safe] },
  ).check(2)
  expect(empty.coverage.reached.status).toBe('complete')
  expect(empty.properties[0]?.verdict).toBe('not-exercised')
  expect(empty.properties[0]?.applicability).toBe('unreachable')
  const atlas = make(program, branching, { properties: [safe] })
  const zero = atlas.check(2, { states: 0 })
  expect(zero.coverage.reached.status).toBe('state-limit')
  expect(zero.properties[0]?.verdict).toBe('not-exercised')
  expect(zero.properties[0]?.applicability).toBe('unobserved')
  expect(atlas.check(2, { enumerationWork: 0 }).coverage.reached.status).toBe(
    'enumeration-limit',
  )
  const limited = atlas.check(0)
  expect(limited.properties[0]?.verdict).toBe('inconclusive')
  expect(limited.coverage.frontier).toEqual(['S1'])
  expect(
    make(program, closed, { properties: [safe] }).check(2).properties[0]
      ?.verdict,
  ).toBe('complete')
  expect(
    make(program, closed, {
      properties: [{ id: 'false', name: 'False', state: () => false }],
    }).check(2).properties[0]?.verdict,
  ).toBe('counterexample')
  const throwing = make(program, closed, {
    properties: [
      {
        id: 'throws',
        name: 'Throws',
        state: () => {
          throw new Error('predicate exploded')
        },
      },
    ],
  }).check(2)
  expect(throwing.properties[0]?.verdict).toBe('error')
  expect(throwing.properties[0]?.errors[0]?.reason).toBe('predicate exploded')
  expect(throwing.violations).toEqual([])
})

test('property IDs distinguish duplicate labels and registration rejects duplicates and missing predicates', () => {
  const report = make(program, closed, {
    properties: [
      { id: 'first', name: 'Same', state: () => false },
      { id: 'second', name: 'Same', state: () => false },
    ],
  }).check(0)
  expect(report.violations.map(failure => failure.propertyId)).toEqual([
    'first',
    'second',
  ])
  expect(() => make(program, closed, { properties: [safe, safe] })).toThrow(
    'Duplicate property identifier',
  )
  expect(() =>
    make(program, closed, { properties: [{ id: 'empty', name: 'Empty' }] }),
  ).toThrow('at least one predicate')
})

test('applicability is explicit, counted independently, and distinguishes unobserved from unreachable', () => {
  const conditional: Property<number, number> = {
    id: 'at-two',
    name: 'At two',
    stateApplies: ({ model }) => model === 2,
    state: ({ model }) => model === 2,
  }
  const atlas = make(program, branching, { properties: [conditional] })
  expect(atlas.check(0).properties[0]).toMatchObject({
    verdict: 'not-exercised',
    applicability: 'unobserved',
    counts: { state: { considered: 1, applicable: 0, evaluated: 0 } },
  })
  const observed = atlas.check(1)
  expect(observed.properties[0]).toMatchObject({
    verdict: 'complete',
    applicability: 'observed',
    counts: { state: { considered: 3, applicable: 1, evaluated: 1 } },
  })
  expect(
    Option.isSome(observed.properties[0]?.maybeWitness ?? Option.none()),
  ).toBe(true)
  const unreachable = make(program, closed, {
    properties: [conditional],
  }).check(2)
  expect(unreachable.properties[0]?.applicability).toBe('unreachable')
})

test('check coverage is its exact BFS graph and remains immutable after unrelated exploration', () => {
  const atlas = make(program, branching, { properties: [safe] })
  const report = atlas.check(0, { transitions: 2, enumerationWork: 99 })
  expect(report.coverage).toMatchObject({
    depth: 0,
    search: 'breadth',
    limits: { transitions: 2, enumerationWork: 99 },
    reached: { states: ['S1'] },
    edges: [],
  })
  expect(Object.isFrozen(report)).toBe(true)
  expect(Object.isFrozen(report.coverage.reached.counters)).toBe(true)
  const before = JSON.stringify(report)
  atlas.reach(3, 'random')
  atlas.interact('S1', 42)
  expect(JSON.stringify(report)).toBe(before)
})

test('transition predicates check all admitted revisited edges with separate counts', () => {
  const atlas = make(
    program,
    {
      *starts() {
        return
      },
      *next() {
        return send(yield* fixture('loop', { first: 0, second: 0 }))
      },
    },
    {
      properties: [
        {
          id: 'loops',
          name: 'Loops',
          state: () => true,
          transition: () => true,
        },
      ],
    },
  )
  const report = atlas.check(0)
  expect(report.coverage.reached.status).toBe('complete')
  expect(report.coverage.edges).toHaveLength(2)
  expect(report.properties[0]?.counts).toMatchObject({
    state: { evaluated: 1 },
    transition: { evaluated: 2 },
  })
})

test('modeling failures retain partial check coverage and never become a pass on a later read', () => {
  const atlas = make(
    program,
    {
      *starts() {
        return
      },
      *next() {
        throw new Error('environment exploded')
      },
    },
    { properties: [safe] },
  )
  const report = atlas.check(2)
  expect(report.coverage.reached.status).toBe('model-error')
  expect(report.coverage.reached.states).toEqual(['S1'])
  expect(report.errors[0]?.reason).toBe('environment exploded')
  expect(report.properties[0]?.verdict).toBe('error')
  expect(atlas.check(2).properties[0]?.verdict).toBe('error')
  expect(() => atlas.reach(2)).toThrow('environment exploded')
  const invalid = make(
    { ...program, Model: Schema.Finite, start: () => ({ model: Number.NaN }) },
    closed,
    { properties: [safe] },
  ).check(0)
  expect(invalid.coverage.reached.status).toBe('model-error')
  expect(invalid.properties[0]?.verdict).toBe('error')
})

test('throwing applicability is an error, not an unevaluated success', () => {
  const report = make(program, closed, {
    properties: [
      {
        id: 'applies-error',
        name: 'Applies error',
        stateApplies: () => {
          throw new Error('cannot decide applicability')
        },
        state: () => true,
      },
    ],
  }).check(0)
  expect(report.coverage.reached.status).toBe('complete')
  expect(report.properties[0]).toMatchObject({
    verdict: 'error',
    applicability: 'unobserved',
    counts: { state: { considered: 1, applicable: 0, evaluated: 0 } },
    errors: [{ stage: 'applicability' }],
  })
  const witnessed = make(program, branching, {
    properties: [
      {
        id: 'partly-observed',
        name: 'Partly observed',
        stateApplies: ({ model }) => {
          if (model === 0) {
            return true
          }
          throw new Error('cannot decide later applicability')
        },
        state: () => true,
      },
    ],
  }).check(1)
  expect(witnessed.coverage.reached.status).toBe('complete')
  expect(witnessed.properties[0]).toMatchObject({
    verdict: 'error',
    applicability: 'observed',
    counts: { state: { considered: 3, applicable: 1, evaluated: 1 } },
  })
  expect(
    Option.isSome(witnessed.properties[0]?.maybeWitness ?? Option.none()),
  ).toBe(true)
})

const submissionProperty = Option.getOrThrow(
  Option.fromNullishOr(
    signupProperties.find(
      property => property.id === 'submitting-creates-the-displayed-account',
    ),
  ),
)
const confirming = modifyFields(Signup.init('Free').model, {
  username: () => 'ada',
  step: () => Signup.Step.Confirm(),
})
const signupProgram = {
  name: 'Issuance',
  Model: Signup.Model,
  Message: Signup.Message,
  view: Signup.view,
  start: () => ({
    model: confirming,
    commands: [Signup.CreateAccount({ username: 'ada', plan: 'Free' })],
  }),
  update: Signup.update,
}
const submitEnvironment: Environment<Signup.Model, Signup.Message> = {
  *starts() {
    return
  },
  *next({ model }) {
    return model.step._tag === 'Confirm'
      ? send(Signup.Message.SubmittedSignup())
      : yield* fixture('end', {})
  },
}

test('submission issuance does not mistake an already-pending matching Command for a newly issued one', () => {
  const faulty = make(
    {
      ...signupProgram,
      update: model => ({
        model: modifyFields(model, { step: () => Signup.Step.Creating() }),
      }),
    },
    submitEnvironment,
    { properties: [submissionProperty] },
  ).check(1)
  expect(faulty.properties[0]?.verdict).toBe('counterexample')
  expect(faulty.coverage.edges[0]?.evidence.issued).toEqual([])
  const correct = make(signupProgram, submitEnvironment, {
    properties: [submissionProperty],
  }).check(1)
  expect(correct.properties[0]?.verdict).toBe('complete')
  expect(correct.coverage.edges[0]?.evidence.issued).toEqual([
    { name: 'CreateAccount', args: { username: 'ada', plan: 'Free' } },
  ])
})

test('transition evidence records the selected duplicate request occurrence and exact issuance', () => {
  const atlas = make(
    {
      ...signupProgram,
      start: () => ({
        model: confirming,
        commands: [
          Signup.CreateAccount({ username: 'ada', plan: 'Free' }),
          Signup.CreateAccount({ username: 'ada', plan: 'Free' }),
        ],
      }),
    },
    {
      *starts() {
        return
      },
      *next({ model, pending }) {
        if (model.step._tag !== 'Confirm') {
          return yield* fixture('end', {})
        }
        const command = pending[1]
        if (command === undefined) {
          return yield* fixture('missing', {})
        }
        return answer(
          { index: 1, command },
          Signup.Message.SucceededCreateAccount({ accountId: 'account' }),
        )
      },
    },
    {
      properties: [
        {
          id: 'selected',
          name: 'Selected',
          transition: (before, _message, after, evidence) => {
            expect(before.pending).toHaveLength(2)
            expect(after.pending).toHaveLength(1)
            expect(evidence.issued).toEqual([])
            expect(Option.getOrThrow(evidence.maybeRequest)).toMatchObject({
              index: 1,
              occurrence: 1,
            })
            return true
          },
        },
      ],
    },
  )
  const report = atlas.check(1)
  expect(report.properties[0]?.verdict).toBe('complete')
  expect(
    Option.getOrThrow(
      report.coverage.edges[0]?.evidence.maybeRequest ?? Option.none(),
    ),
  ).toMatchObject({
    index: 1,
    occurrence: 1,
    command: { name: 'CreateAccount' },
  })
})

test('Comparison uses explicit applicability and actual issued Commands without relabeling shared baseline failures', () => {
  const faulty = {
    ...signupProgram,
    update: (model: Signup.Model) => ({
      model: modifyFields(model, { step: () => Signup.Step.Creating() }),
    }),
  }
  const result = compare({
    before: signupProgram,
    after: faulty,
    environment: submitEnvironment,
    properties: [submissionProperty],
    limits: { depth: 1, states: 10, transitions: 10 },
  })
  expect(
    result.propertyFailures.map(failure => [failure.propertyId, failure.side]),
  ).toEqual([[submissionProperty.id, 'after']])
  expect(result.findings.some(finding => finding.kind === 'property')).toBe(
    true,
  )
  const shared = compare({
    before: faulty,
    after: faulty,
    environment: submitEnvironment,
    properties: [submissionProperty],
    limits: { depth: 1, states: 10, transitions: 10 },
  })
  expect(shared.propertyFailures.map(failure => failure.side)).toEqual([
    'before',
    'after',
  ])
  expect(shared.findings).toEqual([])
  expect(() =>
    compare({
      before: signupProgram,
      after: signupProgram,
      environment: submitEnvironment,
      properties: [submissionProperty, submissionProperty],
      limits: { depth: 0, states: 1, transitions: 1 },
    }),
  ).toThrow('Duplicate property identifier')
})

test('an immutable check report survives saved-address replay without gaining live edges', () => {
  const atlas = make(program, branching, { properties: [safe] })
  const report = atlas.check(0)
  const original = JSON.stringify(report)
  const unrelated = make(program, branching)
  const reached = unrelated.reach(1)
  const destination = reached.states.at(-1)
  if (destination === undefined) {
    throw new Error('Expected a destination')
  }
  const resolved = Option.getOrThrow(
    atlas.resolve(unrelated.address(destination)),
  )
  expect(atlas.encode(resolved)).toBe(unrelated.encode(destination))
  expect(JSON.stringify(report)).toBe(original)
  expect(report.coverage.edges).toEqual([])
})

test('a zero alternative budget and invalid update retain truthful coverage and no successful verdict', () => {
  expect(
    make(program, branching, { properties: [safe] }).check(1, {
      transitions: 0,
    }).properties[0],
  ).toMatchObject({ verdict: 'not-exercised', applicability: 'unobserved' })
  const report = make(
    { ...program, Model: Schema.Finite, update: () => ({ model: Number.NaN }) },
    branching,
    { properties: [safe] },
  ).check(1)
  expect(report.coverage.reached.status).toBe('model-error')
  expect(report.coverage.reached.states).toEqual(['S1'])
  expect(report.coverage.edges).toEqual([])
  expect(report.properties[0]?.verdict).toBe('error')
})

test('a remembered enumeration error recharges its work after the retained successful prefix', () => {
  const atlas = make(
    program,
    {
      *starts() {
        return
      },
      *next({ model }) {
        if (model !== 0) {
          return yield* fixture('end', {})
        }
        const selected = yield* fixture('branch', { works: 1, throws: 2 })
        if (selected === 2) {
          throw new Error('second branch failed')
        }
        return send(selected)
      },
    },
    { properties: [safe] },
  )
  const first = atlas.check(2)
  expect(first.coverage.reached.states).toHaveLength(2)
  expect(first.coverage.edges).toHaveLength(1)
  expect(first.coverage.reached.status).toBe('model-error')
  expect(Option.getOrThrow(first.errors[0]?.maybeState ?? Option.none())).toBe(
    'S1',
  )
  atlas.interact('S1', 99)
  const second = atlas.check(2)
  expect(second.coverage.edges).toEqual(first.coverage.edges)
  expect(second.coverage.reached.counters).toEqual(
    first.coverage.reached.counters,
  )
  expect(second.coverage.reached.states).toEqual(first.coverage.reached.states)
  expect(atlas.check(2, { enumerationWork: 0 }).coverage.reached.status).toBe(
    'enumeration-limit',
  )
})
