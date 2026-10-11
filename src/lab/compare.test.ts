import { Array, Effect, Option, Schema } from 'effect'
import { Command, CustomElement } from 'foldkit'
import { expect, test } from 'vitest'

import {
  type Environment,
  type NextState,
  type Program,
  type Transition,
  answer,
  pendingRequests,
  send,
} from './atlas'
import { type ComparisonLimits, compare } from './compare'
import { type Choices, fixture } from './fixture'

const limits: ComparisonLimits = {
  depth: 5,
  states: 100,
  transitions: 1_000,
  pairs: 100,
}

const ReadValue = Command.define('ReadComparisonValue', {
  args: { value: Schema.Number },
  messages: [Schema.Number],
  execute: () => Effect.die('Comparison must never execute Commands'),
})

const Other = Command.define('OtherComparisonWork', {
  messages: [Schema.Number],
  execute: Effect.die('Comparison must never execute Commands'),
})

const numeric = (
  overrides: Partial<
    Pick<Program<number, number, number>, 'start' | 'update' | 'view'>
  > = {},
): Program<number, number, number> => ({
  name: 'Counter',
  Model: Schema.Number,
  Message: Schema.Number,
  start: overrides.start ?? (input => ({ model: input })),
  update: overrides.update ?? ((_model, message) => ({ model: message })),
  view: overrides.view ?? ((model, h) => h.div([], [String(model)])),
})

const environment = (
  next?: (
    state: NextState<number, number, number>,
  ) => Choices<Transition<number>>,
): Environment<number, number, number> => ({
  *starts() {
    return 0
  },
  ...(next === undefined ? {} : { next }),
})

const choices = (values: ReadonlyArray<number>): Choices<Transition<number>> =>
  (function* () {
    return send(
      yield* fixture(
        'event',
        Object.fromEntries(values.map(value => [String(value), value])),
      ),
    )
  })()

const once = environment(state => choices(state.model === 0 ? [1, 2] : []))

test('identical versions agree, including shared observed baseline property failures', () => {
  const program = numeric()
  const result = compare({
    before: program,
    after: program,
    environment: once,
    limits,
    properties: [{ name: 'Positive', state: state => state.model > 0 }],
  })
  expect(result.status).toBe('complete')
  expect(result.findings).toEqual([])
  expect(result.propertyFailures.map(failure => failure.side)).toEqual([
    'before',
    'after',
  ])
  expect(result.counters).toMatchObject({
    starts: 1,
    beforeStates: 3,
    afterStates: 3,
    pairs: 3,
    transitions: 5,
  })
})

test('matches a Message after a copy edit and groups each repeated heading change', () => {
  const before = numeric({
    view: (model, h) =>
      h.div(
        [],
        [
          h.h1([], ['Review account']),
          h.span([], [String(model)]),
          h.button([h.OnClick(1)], ['Continue']),
        ],
      ),
  })
  const after = numeric({
    view: (model, h) =>
      h.div(
        [],
        [
          h.h1([], ['Confirm account']),
          h.span([], [String(model)]),
          h.button([h.OnClick(1)], ['Next']),
        ],
      ),
  })
  const result = compare({ before, after, environment: once, limits })
  expect(
    result.findings.some(
      finding =>
        finding.kind.startsWith('action-') || finding.kind.startsWith('event-'),
    ),
  ).toBe(false)
  const heading = result.findings.find(
    finding =>
      finding.before === 'Review account' &&
      finding.after === 'Confirm account',
  )
  expect(heading?.examples).toHaveLength(3)
  expect(heading?.shortest.depth).toBe(0)
  expect(heading?.examples[1]?.trace[1]?.beforeEvent?.key).toBe(
    heading?.examples[1]?.trace[1]?.afterEvent?.key,
  )
})

test('records an unmatched action only on the real side and replays it freshly', () => {
  const before = numeric({
    view: (_model, h) => h.button([h.OnClick(1)], ['Retry']),
  })
  const after = numeric({ view: (_model, h) => h.div([], ['Unavailable']) })
  const shared: Environment<number, number, number> = {
    *starts() {
      return 0
    },
    inputs: [],
    *next(state) {
      return send(yield* fixture('interaction', state.interactions))
    },
  }
  const result = compare({ before, after, environment: shared, limits })
  const finding = result.findings.find(
    finding => finding.kind === 'action-removed',
  )
  const terminal = finding?.examples.find(
    example => example.trace.at(-1)?.beforeEvent !== undefined,
  )
  expect(finding?.title).toContain('Retry')
  expect(terminal?.trace.at(-1)?.before?.model).toBe(1)
  expect(terminal?.trace.at(-1)?.after).toBeUndefined()
  expect(terminal?.trace.at(-1)?.afterEvent).toBeUndefined()
  expect(terminal).toBeDefined()
  if (terminal !== undefined) {
    const fresh = compare({ before, after, environment: shared, limits })
    const replayed = fresh.replay(terminal.trace)
    expect(replayed.at(-1)?.before?.model).toBe(1)
    expect(replayed.at(-1)?.after).toBeUndefined()
  }
})

test('an added submission records its extra pending work and state-property failure', () => {
  const before = numeric({
    start: () => ({ model: 0, commands: [ReadValue({ value: 1 })] }),
    view: (_model, h) => h.div([], ['Waiting']),
  })
  const after = numeric({
    start: before.start,
    update: model => ({ model, commands: [ReadValue({ value: 1 })] }),
    view: (_model, h) => h.button([h.OnClick(1)], ['Submit again']),
  })
  const shared: Environment<number, number, number> = {
    *starts() {
      return 0
    },
    inputs: [],
    *next(state) {
      return send(yield* fixture('interaction', state.interactions))
    },
  }
  const result = compare({
    before,
    after,
    environment: shared,
    limits,
    properties: [
      {
        name: 'At most one request',
        state: state => state.pending.length <= 1,
      },
    ],
  })
  const failure = result.findings.find(finding => finding.kind === 'property')
  expect(failure?.title).toContain('failed after')
  expect(failure?.shortest.after?.pending).toHaveLength(2)
  expect(failure?.shortest.before).toBeUndefined()
  expect(result.findings.some(finding => finding.kind === 'commands')).toBe(
    true,
  )
  expect(
    result.replay(failure?.shortest.trace ?? []).at(-1)?.after?.pending,
  ).toHaveLength(2)
})

test('observes changes to initialization and initial Command arguments at depth zero', () => {
  const before = numeric({
    start: () => ({ model: 1, commands: [ReadValue({ value: 1 })] }),
  })
  const after = numeric({
    start: () => ({ model: 2, commands: [ReadValue({ value: 2 })] }),
  })
  const result = compare({
    before,
    after,
    environment: environment(),
    limits: { depth: 0, states: 10, transitions: 10 },
  })
  expect(result.status).toBe('complete')
  expect(result.findings.map(finding => finding.kind)).toEqual(
    expect.arrayContaining(['content', 'pending', 'commands']),
  )
  expect(result.findings.every(finding => finding.shortest.depth === 0)).toBe(
    true,
  )
})

test('matches duplicate request occurrences using each side’s local queue positions', () => {
  const repeated = ReadValue({ value: 10 })
  const before = numeric({
    start: () => ({
      model: 0,
      commands: [repeated, Other(), ReadValue({ value: 20 }), repeated],
    }),
    view: (_model, h) => h.div([], ['Before']),
  })
  const after = numeric({
    start: () => ({
      model: 0,
      commands: [Other(), repeated, repeated, ReadValue({ value: 20 })],
    }),
    view: (_model, h) => h.div([], ['After']),
  })
  const shared = environment(function* (state) {
    const request = yield* fixture('pending', pendingRequests(state, ReadValue))
    return answer(request, request.command.args.value)
  })
  const result = compare({ before, after, environment: shared, limits })
  expect(result.findings.every(finding => finding.kind === 'content')).toBe(
    true,
  )
  const second = result.findings
    .flatMap(finding => finding.examples)
    .find(
      example =>
        example.depth === 1 &&
        example.trace[1]?.beforeEvent?.request?.occurrence === 1,
    )
  expect(second?.trace[1]?.beforeEvent?.request?.index).toBe(3)
  expect(second?.trace[1]?.afterEvent?.request?.index).toBe(2)
  expect(second?.before?.pending).toHaveLength(3)
  expect(second?.after?.pending).toHaveLength(3)
  if (second !== undefined) {
    expect(result.replay(second.trace).at(-1)?.after?.pending).toEqual(
      second.after?.pending,
    )
  }
})

test('continues after an observation differs and visits pairs of already familiar individual states', () => {
  const before = numeric({
    update: (_model, message) => ({
      model: message === 2 ? 0 : message === 4 ? 2 : 1,
    }),
  })
  const after = numeric({
    update: (_model, message) => ({
      model: message === 1 ? 0 : message === 4 ? 3 : 1,
    }),
  })
  const shared = environment(state =>
    choices(state.model === 0 ? [1, 2, 3] : state.model === 1 ? [4] : []),
  )
  const result = compare({ before, after, environment: shared, limits })
  const later = result.findings.find(
    finding => finding.before === '2' && finding.after === '3',
  )
  expect(later?.shortest.depth).toBe(2)
  expect(later?.shortest.trace[1]?.beforeEvent?.message).toBe(3)
  expect(later?.shortest.trace[2]?.beforeEvent?.message).toBe(4)
  expect(result.counters.pairs).toBeGreaterThan(result.counters.beforeStates)
})

test('checks every transition property even when both edges return to an existing pair', () => {
  const before = numeric({
    update: model => ({ model }),
    view: (_model, h) => h.div([]),
  })
  const after = numeric({
    start: () => ({ model: 1 }),
    update: model => ({ model }),
    view: before.view,
  })
  const result = compare({
    before,
    after,
    environment: environment(() => choices([1, 2])),
    limits,
    properties: [
      {
        name: 'Result is zero',
        transition: (_before, _message, after) => after.model === 0,
      },
    ],
  })
  expect(result.counters.pairs).toBe(1)
  expect(result.findings).toHaveLength(1)
  expect(result.findings[0]?.kind).toBe('property')
  expect(result.findings[0]?.examples).toHaveLength(2)
  expect(result.propertyFailures).toHaveLength(2)
})

test('partial event enumeration stays unknown and resumes without dropping alternatives', () => {
  const before = numeric({
    update: () => ({ model: 2 }),
    view: (_model, h) => h.div([]),
  })
  const after = numeric({
    start: () => ({ model: 1 }),
    update: before.update,
    view: before.view,
  })
  const shared = environment(state =>
    choices(state.model === 0 ? [10, 20] : state.model === 1 ? [20, 10] : []),
  )
  const result = compare({
    before,
    after,
    environment: shared,
    limits: { depth: 2, states: 10, transitions: 3 },
  })
  expect(result.status).toBe('transition-limit')
  expect(result.findings).toEqual([])
  expect(result.unfinishedWork).toContainEqual(
    expect.objectContaining({
      kind: 'pair',
      before: 'partial',
      after: 'partial',
      beforeAlternatives: 1,
      afterAlternatives: 1,
    }),
  )
  result.resume({ depth: 2, states: 10, transitions: 20 })
  expect(result.status).toBe('complete')
  expect(result.findings).toEqual([])
  expect(result.counters).toMatchObject({
    starts: 1,
    beforeTransitions: 2,
    afterTransitions: 2,
    transitions: 5,
    pairs: 2,
  })
  expect(result.unfinishedWork).toEqual([])
})

test('a state limit preserves the already consumed transition for resumption', () => {
  const program = numeric()
  const result = compare({
    before: program,
    after: program,
    environment: once,
    limits: { depth: 2, states: 1, pairs: 10, transitions: 20 },
  })
  expect(result.status).toBe('state-limit')
  expect(result.counters).toMatchObject({
    beforeStates: 1,
    afterStates: 1,
    transitions: 3,
  })
  result.resume({ depth: 2, states: 3, pairs: 10, transitions: 20 })
  expect(result.status).toBe('complete')
  expect(result.counters).toMatchObject({
    beforeStates: 3,
    afterStates: 3,
    transitions: 5,
  })
  expect(result.findings).toEqual([])
})

test('pair limits count pairs separately from the states on either side', () => {
  const before = numeric({
    update: () => ({ model: 0 }),
    view: (_model, h) => h.div([]),
  })
  const after = numeric({ view: before.view })
  const result = compare({
    before,
    after,
    environment: environment(() => choices([1, 2])),
    limits: { depth: 2, states: 10, pairs: 2, transitions: 100 },
  })
  expect(result.status).toBe('pair-limit')
  expect(result.counters).toMatchObject({
    beforeStates: 1,
    afterStates: 2,
    pairs: 2,
  })
  result.resume({ depth: 2, states: 10, pairs: 4, transitions: 100 })
  expect(result.status).toBe('complete')
  expect(result.counters).toMatchObject({
    beforeStates: 1,
    afterStates: 3,
    pairs: 3,
  })
})

test('initialization is depth zero and a depth-limited pair remains unfinished', () => {
  const program = numeric()
  const result = compare({
    before: program,
    after: program,
    environment: once,
    limits: { depth: 0, states: 10, transitions: 100 },
  })
  expect(result.status).toBe('depth-limit')
  expect(result.counters).toMatchObject({ starts: 1, transitions: 1, pairs: 1 })
  expect(result.unfinishedWork[0]).toMatchObject({
    depth: 0,
    before: 'unstarted',
    after: 'unstarted',
  })
  result.resume({ depth: 2, states: 10, transitions: 100 })
  expect(result.status).toBe('complete')
  expect(result.counters.pairs).toBe(3)
})

test('counts alternatives even when every Message returns to the same state', () => {
  const program = numeric({ update: model => ({ model }) })
  const shared = environment(() => choices(Array.range(1, 500)))
  const result = compare({
    before: program,
    after: program,
    environment: shared,
    limits: { depth: 1, states: 2, transitions: 9 },
  })
  expect(result.status).toBe('transition-limit')
  expect(result.counters).toMatchObject({
    pairs: 1,
    beforeStates: 1,
    afterStates: 1,
    transitions: 9,
    beforeTransitions: 4,
    afterTransitions: 4,
  })
  result.resume({ depth: 1, states: 2, transitions: 1_010 })
  expect(result.status).toBe('complete')
  expect(result.counters.transitions).toBe(1_001)
})

test('rejects duplicate semantic event keys explicitly', () => {
  const program = numeric()
  const shared = environment(function* () {
    return send(yield* fixture('duplicate', { one: 1, another: 1 }))
  })
  expect(() =>
    compare({ before: program, after: program, environment: shared, limits }),
  ).toThrow('Duplicate comparison event key')
})

test('invalid Messages and fabricated pending occurrences are errors, not removed events', () => {
  const integer: Program<number, number, number> = {
    name: 'Integer',
    Model: Schema.Number,
    Message: Schema.Int,
    start: input => ({ model: input }),
    update: (_model, message) => ({ model: message }),
    view: (_model, h) => h.div([]),
  }
  expect(() =>
    compare({
      before: integer,
      after: integer,
      environment: environment(() => choices([0.5])),
      limits,
    }),
  ).toThrow('next returned an invalid Message')
  const pending = numeric({
    start: () => ({ model: 0, commands: [ReadValue({ value: 1 })] }),
  })
  const fake = environment(function* () {
    return answer({ index: 0, command: ReadValue({ value: 1 }) }, 1)
  })
  expect(() =>
    compare({ before: pending, after: pending, environment: fake, limits }),
  ).toThrow('answer must select a pending Command from this state')
})

test('compares newly issued Commands even after pending queues converge', () => {
  const before = numeric({
    start: () => ({ model: 0, commands: [ReadValue({ value: 1 })] }),
  })
  const after = numeric({
    update: (_model, message) => ({
      model: message,
      commands: [ReadValue({ value: 1 })],
    }),
  })
  const result = compare({
    before,
    after,
    environment: environment(state => choices(state.model === 0 ? [1] : [])),
    limits,
  })
  const event = result.findings
    .filter(finding => finding.kind === 'commands')
    .flatMap(finding => finding.examples)
    .find(example => example.depth === 1)
  expect(event?.before?.pending).toEqual(event?.after?.pending)
  expect(event?.trace[1]?.beforeIssued).toEqual([])
  expect(event?.trace[1]?.afterIssued).toHaveLength(1)
})

test('compatible protocols can compare different Model representations without reporting raw Model changes', () => {
  const ObjectModel = Schema.Struct({ count: Schema.Number })
  type ObjectModel = typeof ObjectModel.Type
  const before = numeric()
  const after: Program<ObjectModel, number, number> = {
    name: 'Object counter',
    Model: ObjectModel,
    Message: Schema.Number,
    start: input => ({ model: { count: input } }),
    update: (_model, message) => ({ model: { count: message } }),
    view: (model, h) => h.div([], [String(model.count)]),
  }
  const shared: Environment<number | ObjectModel, number, number> = {
    *starts() {
      return 0
    },
    next: state =>
      choices(
        (typeof state.model === 'number' ? state.model : state.model.count) ===
          0
          ? [1, 2]
          : [],
      ),
  }
  const result = compare({ before, after, environment: shared, limits })
  expect(result.status).toBe('complete')
  expect(result.findings).toEqual([])
  expect(result.counters.pairs).toBe(3)
})

test('starting inputs remain part of execution identity when future environment choices differ', () => {
  const program = numeric({
    start: () => ({ model: 0 }),
    update: model => ({ model }),
    view: (_model, h) => h.div([]),
  })
  const shared: Environment<number, number, number> = {
    *starts() {
      return yield* fixture('arrival', { one: 1, two: 2 })
    },
    next: state => choices([state.input]),
  }
  const result = compare({
    before: program,
    after: program,
    environment: shared,
    limits,
  })
  expect(result.counters).toMatchObject({
    starts: 2,
    beforeStates: 2,
    afterStates: 2,
    pairs: 2,
    transitions: 6,
  })
  expect(result.status).toBe('complete')
})

test('fresh replay rejects a changed starting input even when the Model and view stay equal', () => {
  const source = { input: 1 }
  const before = numeric({
    start: () => ({ model: 0 }),
    view: (_model, h) => h.div([], ['Before']),
  })
  const after = numeric({
    start: before.start,
    view: (_model, h) => h.div([], ['After']),
  })
  const shared: Environment<number, number, number> = {
    *starts() {
      return source.input
    },
  }
  const result = compare({ before, after, environment: shared, limits })
  const trace = result.findings[0]?.shortest.trace
  expect(trace?.[0]?.before?.input).toBe(1)
  source.input = 2
  if (trace !== undefined) {
    expect(() => result.replay(trace)).toThrow('Comparison replay diverged')
  }
})

test('groups the same changed Command occurrences across different common work and queue orders', () => {
  const before = numeric({
    start: input => ({
      model: 0,
      commands:
        input === 0
          ? [ReadValue({ value: 1 }), Other()]
          : [Other(), ReadValue({ value: 1 }), ReadValue({ value: 2 })],
    }),
  })
  const after = numeric({
    start: input => ({
      model: 0,
      commands: input === 0 ? [Other()] : [ReadValue({ value: 2 }), Other()],
    }),
  })
  const shared: Environment<number, number, number> = {
    *starts() {
      return yield* fixture('arrival', { first: 0, second: 1 })
    },
  }
  const result = compare({ before, after, environment: shared, limits })
  expect(
    result.findings.filter(finding => finding.kind === 'pending'),
  ).toHaveLength(1)
  expect(
    result.findings.filter(finding => finding.kind === 'commands'),
  ).toHaveLength(1)
  expect(result.findings.every(finding => finding.examples.length === 2)).toBe(
    true,
  )
})

const ComparisonElement = CustomElement.define({
  tag: 'comparison-element',
  properties: { value: Schema.Unknown },
  events: {},
})

test('preserves absent properties, undefined values, and Option variants in structured content differences', () => {
  const missing = numeric({
    view: (_model, h) => ComparisonElement.withMessage(h)([]),
  })
  const defined = numeric({
    view: (_model, h) => {
      const element = ComparisonElement.withMessage(h)
      return element([element.Value(undefined)])
    },
  })
  const none = numeric({
    view: (_model, h) => {
      const element = ComparisonElement.withMessage(h)
      return element([element.Value(Option.none())])
    },
  })
  const some = numeric({
    view: (_model, h) => {
      const element = ComparisonElement.withMessage(h)
      return element([element.Value(Option.some(undefined))])
    },
  })
  expect(
    compare({
      before: missing,
      after: defined,
      environment: environment(),
      limits,
    }).findings,
  ).toHaveLength(1)
  expect(
    compare({ before: none, after: some, environment: environment(), limits })
      .findings,
  ).toHaveLength(1)
})

test('groups a repeated removed fragment independently of unchanged sibling text', () => {
  const before = numeric({
    view: (model, h) =>
      h.div(
        [],
        [
          h.span([], [`Account ${model}`]),
          h.button([h.OnClick(1)], ['Retry']),
          h.p([], ['Contact support']),
        ],
      ),
  })
  const after = numeric({
    view: (model, h) =>
      h.div(
        [],
        [h.span([], [`Account ${model}`]), h.p([], ['Contact support'])],
      ),
  })
  const result = compare({ before, after, environment: once, limits })
  const content = result.findings.filter(finding => finding.kind === 'content')
  expect(content).toHaveLength(1)
  expect(content[0]?.examples).toHaveLength(3)
  expect(content[0]?.description).toBe('The rendered structure changed.')
  expect(JSON.stringify(content[0]?.before)).toContain('Retry')
  expect(JSON.stringify(content[0]?.before)).not.toContain('Account')
})
