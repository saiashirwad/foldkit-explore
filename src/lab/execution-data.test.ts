import { Array, Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import { inertHtml as ih } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'
import { expect, test, vi } from 'vitest'

import { type Program, make, send } from './atlas'
import { canonical } from './canonical'
import { compare } from './compare'
import { fixture } from './fixture'
import { makeIdentity } from './identity'

const limits = { depth: 1, states: 100, transitions: 100 }
const program: Program<number, number, unknown> = {
  name: 'Data contract',
  Model: Schema.Number,
  Message: Schema.Number,
  start: () => ({ model: 0 }),
  update: (_model, message) => ({ model: message }),
  view: (model, h) => h.p([], [String(model)]),
}

const hiddenInput = (mode: string) =>
  Object.defineProperty({ mode }, 'mode', { enumerable: false })
const hiddenProgram: Program<number, number, Readonly<{ mode: string }>> = {
  name: 'Hidden context',
  Model: Schema.Number,
  Message: Schema.Number,
  start: () => ({ model: 0 }),
  update: (_model, message) => ({ model: message }),
  view: (model, h) => h.p([], [String(model)]),
}
const hiddenEnvironment = {
  *starts() {
    return yield* fixture('mode', {
      left: hiddenInput('left'),
      right: hiddenInput('right'),
    })
  },
  *next(state: Readonly<{ input: Readonly<{ mode: string }> }>) {
    return send(state.input.mode === 'left' ? 1 : 2)
  },
}

test('non-enumerable input context retains both Atlas roots and future behaviors', () => {
  const atlas = make(hiddenProgram, hiddenEnvironment)
  const starts = atlas.reach(0).states
  expect(starts).toHaveLength(2)
  expect(starts.map(atlas.encode)).toEqual([0, 0])
  const successors = starts.map(state => atlas.successors(state))
  expect(
    successors.map(steps => steps.map(step => atlas.encode(step.to))),
  ).toEqual([[1], [2]])
  const target = Option.getOrThrow(
    Array.head(Option.getOrThrow(Array.last(successors))),
  ).to
  const fresh = make(hiddenProgram, hiddenEnvironment)
  const replayed = Option.getOrThrow(fresh.resolve(atlas.address(target)))
  expect(fresh.encode(replayed)).toBe(2)
})

test('Comparison and fresh replay support non-enumerable input context', () => {
  const comparison = compare({
    before: hiddenProgram,
    after: hiddenProgram,
    environment: hiddenEnvironment,
    properties: [{ name: 'Replay context', state: () => false }],
    limits,
  })
  expect(comparison.findings).toEqual([])
  expect(comparison.counters.starts).toBe(2)
  expect(comparison.counters.beforeStates).toBe(4)
  expect(comparison.counters.afterStates).toBe(4)
  const failure = Option.getOrThrow(Array.head(comparison.propertyFailures))
  const replayed = comparison.replay(failure.example.trace)
  expect(replayed[0]?.before?.input).toEqual(
    failure.example.trace[0]?.before?.input,
  )
  expect(replayed[0]?.after?.input).toEqual(
    failure.example.trace[0]?.after?.input,
  )
})

test('unsupported input is rejected before Atlas or Comparison executes start', () => {
  const started = vi.fn()
  const invalidInput = Object.defineProperty({}, 'mode', { get: () => 'left' })
  const checked: Program<number, number, unknown> = {
    name: program.name,
    Model: program.Model,
    Message: program.Message,
    start: () => {
      started()
      return { model: 0 }
    },
    update: program.update,
    view: program.view,
  }
  const environment = {
    *starts() {
      return invalidInput
    },
  }
  expect(() => make(checked, environment).reach(0)).toThrow(
    'Cannot identify an accessor property at Data contract.input["mode"]',
  )
  expect(() =>
    compare({ before: checked, after: checked, environment, limits }),
  ).toThrow(
    'Cannot identify an accessor property at Data contract.input["mode"]',
  )
  expect(started).not.toHaveBeenCalled()
})

const ReadData = Command.define('ReadData', {
  args: { value: Schema.Unknown },
  messages: [Schema.Number],
  execute: () => Effect.die('Exploration must not execute Commands'),
})

test('unsupported initial Models and Command arguments fail before entering either graph', () => {
  const invalid = { nested: { [Symbol('hidden')]: 1 } }
  const invalidModel: Program<unknown, number> = {
    name: 'Invalid output',
    Model: Schema.Unknown,
    Message: Schema.Number,
    start: () => ({ model: invalid }),
    update: model => ({ model }),
    view: (_model, h) => h.div([]),
  }
  const invalidCommand: Program<number, number> = {
    name: 'Invalid output',
    Model: Schema.Number,
    Message: Schema.Number,
    start: () => ({ model: 0, commands: [ReadData({ value: invalid })] }),
    update: model => ({ model }),
    view: (_model, h) => h.div([]),
  }
  const environment = { *starts() {} }
  expect(() => make(invalidModel, environment).reach(0)).toThrow(
    'symbol properties at Invalid output.model["nested"]',
  )
  expect(() =>
    compare({ before: invalidModel, after: invalidModel, environment, limits }),
  ).toThrow('symbol properties at Invalid output.model["nested"]')
  expect(() => make(invalidCommand, environment).reach(0)).toThrow(
    'symbol properties at Invalid output.pending["0"]["args"]["value"]["nested"]',
  )
  expect(() =>
    compare({
      before: invalidCommand,
      after: invalidCommand,
      environment,
      limits,
    }),
  ).toThrow(
    'symbol properties at Invalid output.pending["0"]["args"]["value"]["nested"]',
  )
})

test('unsupported updated Models are rejected by Atlas and Comparison', () => {
  const invalid: Program<unknown, number> = {
    name: 'Invalid update',
    Model: Schema.Unknown,
    Message: Schema.Number,
    start: () => ({ model: {} }),
    update: () => ({ model: { nested: () => 1 } }),
    view: (_model, h) => h.div([]),
  }
  const environment = {
    *starts() {},
    *next() {
      return send(1)
    },
  }
  expect(() => make(invalid, environment).reach(1)).toThrow(
    'Cannot identify function at Invalid update.model["nested"]',
  )
  expect(() =>
    compare({ before: invalid, after: invalid, environment, limits }),
  ).toThrow('Cannot identify function at Invalid update.model["nested"]')
})

const StructuredModel = Schema.Struct({ value: Schema.Number })
type StructuredModel = typeof StructuredModel.Type

const structuredProgram = (
  start: () => StructuredModel,
  update: (message: number) => StructuredModel,
): Program<StructuredModel, number> => ({
  name: 'Structured getter',
  Model: StructuredModel,
  Message: Schema.Number,
  start: () => ({ model: start() }),
  update: (_model, message) => ({ model: update(message) }),
  view: (model, h) => h.p([], [String(model.value)]),
})

const structuredEnvironment = {
  *starts() {},
  *next() {
    return send(1)
  },
}

const structuredAccessorError =
  'Cannot identify an accessor property at Structured getter.model["value"]'

test.each(['start', 'update'])(
  'structured Model accessors from %s are rejected without invoking them',
  stage => {
    const getter = vi.fn(() => 0)
    const accessor = Object.defineProperty({ value: 0 }, 'value', {
      get: getter,
    })
    const checked = structuredProgram(
      () => (stage === 'start' ? accessor : { value: 0 }),
      () => accessor,
    )
    expect(() => make(checked, structuredEnvironment).reach(1)).toThrow(
      structuredAccessorError,
    )
    expect(() =>
      compare({
        before: checked,
        after: checked,
        environment: structuredEnvironment,
        limits,
      }),
    ).toThrow(structuredAccessorError)
    expect(getter).not.toHaveBeenCalled()
  },
)

test.each(['start', 'update'])(
  'fresh replay rejects a structured Model accessor from %s without invoking it',
  stage => {
    const getter = vi.fn(() => 0)
    const accessor = Object.defineProperty({ value: 0 }, 'value', {
      get: getter,
    })
    const invalid = { enabled: false }
    const checked = structuredProgram(
      () => (invalid.enabled && stage === 'start' ? accessor : { value: 0 }),
      message => (invalid.enabled ? accessor : { value: message }),
    )
    const atlas = make(checked, structuredEnvironment)
    const target = Option.getOrThrow(Array.last(atlas.reach(1).states))
    const comparison = compare({
      before: checked,
      after: checked,
      environment: structuredEnvironment,
      properties: [
        { name: 'At zero', state: state => state.model.value === 0 },
      ],
      limits,
    })
    const trace = Option.getOrThrow(Array.head(comparison.propertyFailures))
      .example.trace
    expect(trace).toHaveLength(2)
    invalid.enabled = true
    expect(() =>
      make(checked, structuredEnvironment).resolve(atlas.address(target)),
    ).toThrow(structuredAccessorError)
    expect(() => comparison.replay(trace)).toThrow(structuredAccessorError)
    expect(getter).not.toHaveBeenCalled()
  },
)

test('replay evidence and previews reject structured Model accessors before schema checks', () => {
  const checked = structuredProgram(
    () => ({ value: 0 }),
    value => ({ value }),
  )
  const comparison = compare({
    before: checked,
    after: checked,
    environment: structuredEnvironment,
    properties: [{ name: 'At zero', state: state => state.model.value === 0 }],
    limits,
  })
  const example = Option.getOrThrow(
    Array.head(comparison.propertyFailures),
  ).example
  const getter = vi.fn(() => 0)
  const accessor = Object.defineProperty({ value: 0 }, 'value', { get: getter })
  const trace = Array.map(example.trace, (frame, index) =>
    index === 0
      ? modifyFields(frame, {
          before: before =>
            before === undefined
              ? undefined
              : modifyFields(before, { model: () => accessor }),
        })
      : frame,
  )
  expect(() => comparison.replay(trace)).toThrow(structuredAccessorError)
  expect(() =>
    comparison.render(
      'before',
      modifyFields(example, { trace: () => trace }),
      0,
      'preview',
      ih,
      () => {
        throw new Error('Invalid preview must not emit Messages')
      },
    ),
  ).toThrow(structuredAccessorError)
  expect(getter).not.toHaveBeenCalled()
})

test('pending Command envelopes and arguments cannot invalidate cached identities', () => {
  const command = ReadData({ value: { count: 0 } })
  const pending = [command]
  const checked: Program<number, number> = {
    name: program.name,
    Model: program.Model,
    Message: program.Message,
    start: () => ({ model: 0, commands: pending }),
    update: program.update,
    view: program.view,
  }
  make(checked, { *starts() {} }).reach(0)
  expect(Object.isFrozen(pending)).toBe(true)
  expect(Object.isFrozen(command)).toBe(true)
  expect(Object.isFrozen(command.args)).toBe(true)
  expect(Reflect.set(command, 'name', 'Changed')).toBe(false)
  expect(Reflect.set(command, 'args', { value: 1 })).toBe(false)
  expect(Reflect.set(command.args, 'value', 1)).toBe(false)
})

test('Command metadata accessors are rejected without running them', () => {
  const getter = vi.fn(() => ({ value: 1 }))
  const command = Object.defineProperty(ReadData({ value: 1 }), 'args', {
    get: getter,
  })
  const checked: Program<number, number> = {
    name: program.name,
    Model: program.Model,
    Message: program.Message,
    start: () => ({ model: 0, commands: [command] }),
    update: program.update,
    view: program.view,
  }
  const environment = { *starts() {} }
  expect(() => make(checked, environment).reach(0)).toThrow(
    'Cannot identify an accessor property at Data contract.pending["0"]["args"]',
  )
  expect(() =>
    compare({ before: checked, after: checked, environment, limits }),
  ).toThrow(
    'Cannot identify an accessor property at Data contract.pending["0"]["args"]',
  )
  expect(getter).not.toHaveBeenCalled()
})

test('identity and matching share the supported value domain', () => {
  const identity = makeIdentity()
  const supported = [
    undefined,
    null,
    true,
    'text',
    NaN,
    Infinity,
    -Infinity,
    0,
    -0,
    1n,
    {},
    { field: undefined },
    Object.create(null),
    Object.defineProperty({}, 'hidden', { value: 1 }),
    [undefined, { field: 1 }],
    Option.none(),
    Option.some({ field: -0 }),
  ]
  supported.forEach(value => {
    expect(() => identity.of(value)).not.toThrow()
    expect(() => canonical(value)).not.toThrow()
  })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const unsupported = [
    Symbol('value'),
    () => 1,
    new Date(),
    new Map(),
    { [Symbol('key')]: 1 },
    Object.defineProperty({}, 'field', { get: () => 1 }),
    cyclic,
    new globalThis.Array<unknown>(1),
    Object.defineProperty([], 'field', { value: 1 }),
    Object.defineProperty(Option.some(1), 'field', { value: 1 }),
  ]
  unsupported.forEach(value => {
    expect(() => identity.of(value)).toThrow()
    expect(() => canonical(value)).toThrow()
  })
})
