import { Array, Option, Predicate, Schema } from 'effect'
import { expect, test } from 'vitest'

import { type Address, make, send } from './atlas'
import { canonical } from './canonical'
import {
  EvidenceArtifact,
  EvidenceStep,
  type ReplayIdentity,
  evidenceArtifact,
  parseEvidence,
  serializeEvidence,
} from './evidence'
import {
  EvidenceData,
  decodeEvidenceData,
  encodeEvidenceData,
} from './evidence-data'
import { evidenceFixture, evidenceIdentity } from './evidence-test'
import { fixture } from './fixture'
import { makeIdentity } from './identity'
import {
  ReplayCancelledError,
  ReplayDivergenceError,
  ReplayLimitError,
  finishReplay,
} from './replay'

const processModule = 'node:child_process'
const subprocess: unknown = await import(processModule)
const executeFreshProcess = (script: string, input: string): string => {
  if (
    !Predicate.hasProperty(subprocess, 'execFileSync') ||
    typeof subprocess.execFileSync !== 'function'
  ) {
    throw new Error(
      'The fresh-process evidence test requires a Node child-process host.',
    )
  }
  const output: unknown = subprocess.execFileSync('bun', ['--eval', script], {
    input,
    encoding: 'utf8',
  })
  if (typeof output !== 'string') {
    throw new Error('Expected a serialized artifact from the fresh process.')
  }
  return output
}

const selectedAddress: Address = [
  {
    kind: 'Start',
    decisions: [{ fixture: 'seed', option: 'chosen' }],
    maybeMessage: Option.none(),
  },
  {
    kind: 'Answer',
    decisions: [{ fixture: 'request', option: 'second' }],
    maybeMessage: Option.some(1),
  },
  {
    kind: 'Move',
    decisions: [{ fixture: 'move', option: 'finish' }],
    maybeMessage: Option.some(2),
  },
  { kind: 'Event', decisions: [], maybeMessage: Option.some(3) },
]

const roundTrip = (value: unknown): unknown =>
  decodeEvidenceData(
    Schema.decodeUnknownSync(EvidenceData)(
      JSON.parse(JSON.stringify(encodeEvidenceData(value))),
    ),
  )

const errorReason = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    if (error instanceof ReplayDivergenceError) {
      return error.reason
    }
    throw error
  }
  throw new Error('Expected an evidence divergence.')
}

const artifact = () =>
  finishReplay(
    evidenceFixture().replayAddressSteps(selectedAddress, evidenceIdentity),
  )

test('the native data codec round-trips undefined, absent fields, Option, signed zero and other supported primitives', () => {
  const record: Record<string, unknown> = {
    present: undefined,
    zero: 0,
    negativeZero: -0,
    nan: NaN,
    infinity: Infinity,
    negativeInfinity: -Infinity,
    bigint: 9007199254740993n,
    some: Option.some(undefined),
    none: Option.none(),
  }
  Object.defineProperty(record, 'hidden', {
    value: 'own data',
    enumerable: false,
  })
  const nullRecord = Object.create(null)
  Object.defineProperty(nullRecord, 'value', {
    value: undefined,
    enumerable: false,
  })
  const value = [record, nullRecord]
  const restored = roundTrip(value)
  expect(restored).toEqual(value)
  expect(canonical(restored)).toBe(canonical(value))
  if (!Array.isArray(restored)) {
    throw new Error('Expected restored array.')
  }
  const first = restored[0]
  if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(first)) {
    throw new Error('Expected restored data record.')
  }
  expect(Object.hasOwn(first, 'present')).toBe(true)
  expect(Object.hasOwn(first, 'absent')).toBe(false)
  expect(Object.is(first['negativeZero'], -0)).toBe(true)
  expect(Object.getOwnPropertyDescriptor(first, 'hidden')?.enumerable).toBe(
    false,
  )
  expect(Object.getPrototypeOf(restored[1])).toBeNull()
  expect(first['some']).toEqual(Option.some(undefined))
  expect(first['none']).toEqual(Option.none())
  expect(encodeEvidenceData({ absent: undefined })).not.toEqual(
    encodeEvidenceData({}),
  )
  expect(encodeEvidenceData(Option.some(undefined))).not.toEqual(
    encodeEvidenceData(Option.none()),
  )
  expect(encodeEvidenceData(0)).not.toEqual(encodeEvidenceData(-0))
})

test('native data retains own property order and enumerability without prototype pollution', () => {
  const array = [undefined, -0]
  Object.defineProperty(array, '0', { enumerable: false })
  const value = Object.fromEntries([
    ['z', array],
    ['a', undefined],
    ['__proto__', { polluted: true }],
  ])
  const restored = roundTrip(value)
  expect(Object.getOwnPropertyNames(restored)).toEqual(['z', 'a', '__proto__'])
  expect(Object.getPrototypeOf(restored)).toBe(Object.prototype)
  expect(Object.getOwnPropertyDescriptor(restored, '__proto__')?.value).toEqual(
    { polluted: true },
  )
  expect(Object.hasOwn({}, 'polluted')).toBe(false)
  expect(canonical(restored)).toBe(canonical(value))
  const restoredArray = Object.getOwnPropertyDescriptor(restored, 'z')?.value
  expect(Object.getOwnPropertyDescriptor(restoredArray, '0')?.enumerable).toBe(
    false,
  )
})

test('unsupported data fails explicitly and does not invoke accessors', () => {
  const calls = { getters: 0 }
  const accessor = Object.defineProperty({}, 'secret', {
    get: () => {
      calls.getters += 1
      return 1
    },
  })
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  const sparse = new globalThis.Array(2)
  const unsupported = [
    { [Symbol('field')]: 1 },
    accessor,
    cyclic,
    sparse,
    new Date(),
    { value: () => 1 },
  ]
  Array.forEach(unsupported, value =>
    expect(() => encodeEvidenceData(value, 'input')).toThrow(
      /Cannot canonicalize .* at input/,
    ),
  )
  expect(calls.getters).toBe(0)
  expect(() =>
    decodeEvidenceData(EvidenceData.Number({ value: '-00' })),
  ).toThrow(ReplayDivergenceError)
  expect(() =>
    decodeEvidenceData(EvidenceData.BigInt({ value: '01' })),
  ).toThrow(ReplayDivergenceError)
  expect(() =>
    decodeEvidenceData(
      EvidenceData.Record({
        prototype: 'plain',
        properties: [
          { key: 'same', enumerable: true, value: EvidenceData.Null() },
          { key: 'same', enumerable: true, value: EvidenceData.Null() },
        ],
      }),
    ),
  ).toThrow(ReplayDivergenceError)
})

test('serialized native evidence replays in a fresh process without session IDs or Command effects', () => {
  const recorded = artifact()
  const serialized = serializeEvidence(recorded)
  expect(serialized).not.toContain('"id":')
  expect(serialized).not.toContain('"effect":')
  expect(recorded.steps.map(step => step._tag)).toEqual([
    'Start',
    'Answer',
    'Move',
    'Event',
  ])
  const initial = recorded.steps[0]
  const reply = recorded.steps[1]
  expect(initial?.issued).toHaveLength(2)
  expect(initial?.execution.pending).toHaveLength(2)
  if (reply?._tag !== 'Answer') {
    throw new Error('Expected a recorded reply.')
  }
  expect(reply.request.index).toBe(1)
  expect(reply.request.occurrence).toBe(1)
  expect(reply.issued).toHaveLength(1)
  expect(
    decodeEvidenceData(reply.issued[0]?.args ?? EvidenceData.Null()),
  ).toEqual({ value: 99 })
  expect(reply.execution.pending).toHaveLength(2)
  const decoded = parseEvidence(serialized)
  expect(evidenceFixture().replayEvidence(decoded, evidenceIdentity)).toEqual(
    recorded,
  )
  const script = `
    import { readFileSync } from 'node:fs';
    import { parseEvidence, serializeEvidence } from './src/lab/evidence.ts';
    import { evidenceFixture, evidenceIdentity } from './src/lab/evidence-test.ts';
    const evidence = parseEvidence(readFileSync(0, 'utf8'));
    const replayed = evidenceFixture().replayEvidence(evidence, evidenceIdentity);
    process.stdout.write(serializeEvidence(replayed));
  `
  const freshProcess = executeFreshProcess(script, serialized)
  expect(parseEvidence(freshProcess)).toEqual(recorded)
})

test('replay rejects changed input, initial Commands, occurrence, issuance, Message and observations', () => {
  const recorded = artifact()
  const changed = [
    { inputExtra: 'changed' },
    { initialCommand: 10 },
    { selectedIndex: 0 },
    { issuedCommand: 100 },
    { text: 'Changed UI' },
  ]
  Array.forEach(changed, options => {
    expect(
      errorReason(() =>
        evidenceFixture(options).replayEvidence(recorded, evidenceIdentity),
      ),
    ).toBe('evidence')
  })
  expect(
    errorReason(() =>
      evidenceFixture({ message: 2 }).replayEvidence(
        recorded,
        evidenceIdentity,
      ),
    ),
  ).toBe('message')
})

test('per-step raw/encoded Models and newly issued Commands are checked independently of pending snapshots', () => {
  const recorded = artifact()
  const alteredIssue = evidenceArtifact(
    evidenceIdentity,
    recorded.steps.map(step =>
      step._tag === 'Answer'
        ? EvidenceStep.Answer({ ...step, issued: [] })
        : step,
    ),
  )
  expect(
    errorReason(() =>
      evidenceFixture().replayEvidence(alteredIssue, evidenceIdentity),
    ),
  ).toBe('evidence')
  const alteredModel = evidenceArtifact(
    evidenceIdentity,
    recorded.steps.map(step =>
      step._tag === 'Move'
        ? EvidenceStep.Move({
            ...step,
            execution: {
              ...step.execution,
              encodedModel: encodeEvidenceData({ count: 999 }),
            },
          })
        : step,
    ),
  )
  expect(
    errorReason(() =>
      evidenceFixture().replayEvidence(alteredModel, evidenceIdentity),
    ),
  ).toBe('evidence')
  const alteredRawModel = evidenceArtifact(
    evidenceIdentity,
    recorded.steps.map(step =>
      step._tag === 'Move'
        ? EvidenceStep.Move({
            ...step,
            execution: {
              ...step.execution,
              model: encodeEvidenceData({ count: 999 }),
            },
          })
        : step,
    ),
  )
  expect(
    errorReason(() =>
      evidenceFixture().replayEvidence(alteredRawModel, evidenceIdentity),
    ),
  ).toBe('evidence')
})

test('identity, versions and encodings are explicit and validated before execution', () => {
  const recorded = artifact()
  const identities: ReadonlyArray<ReplayIdentity> = [
    { ...evidenceIdentity, program: 'different-program@1' },
    { ...evidenceIdentity, environment: 'different-environment@1' },
    { ...evidenceIdentity, inputEncoding: 'other-input@1' },
    { ...evidenceIdentity, modelEncoding: 'other-model@1' },
    { ...evidenceIdentity, messageEncoding: 'other-message@1' },
  ]
  const calls = { starts: 0 }
  const atlas = make(
    {
      name: 'Must not execute',
      Model: Schema.Number,
      Message: Schema.Number,
      start: () => {
        calls.starts += 1
        return { model: 0 }
      },
      update: (model: number) => ({ model }),
      view: (_model, h) => h.div([]),
    },
    { *starts() {} },
  )
  Array.forEach(identities, identity =>
    expect(errorReason(() => atlas.replayEvidence(recorded, identity))).toBe(
      'identity',
    ),
  )
  expect(calls.starts).toBe(0)
  expect(
    errorReason(() =>
      parseEvidence(
        serializeEvidence(recorded).replace('"version":1', '"version":2'),
      ),
    ),
  ).toBe('artifact')
  expect(errorReason(() => parseEvidence('{}'))).toBe('artifact')
  expect(errorReason(() => parseEvidence('not JSON'))).toBe('artifact')
  expect(
    errorReason(() =>
      evidenceArtifact({ ...evidenceIdentity, program: '' }, []),
    ),
  ).toBe('identity')
  expect(() =>
    atlas.replayEvidence(recorded, evidenceIdentity, { limits: { hops: 0 } }),
  ).toThrow(ReplayLimitError)
  expect(calls.starts).toBe(0)
})

test('recording selected self-loops retains every step instead of reusing a first-discovery trace', () => {
  const atlas = make(
    {
      name: 'Self-loop',
      Model: Schema.Number,
      Message: Schema.Number,
      start: () => ({ model: 0 }),
      update: (model: number) => ({ model }),
      view: (_model, h) => h.div([]),
    },
    {
      *starts() {},
      *next() {
        return send(1)
      },
    },
  )
  const address: Address = [
    { kind: 'Start', decisions: [], maybeMessage: Option.none() },
    ...Array.makeBy(
      3,
      () =>
        ({
          kind: 'Move',
          decisions: [],
          maybeMessage: Option.some(1),
        }) satisfies Address[number],
    ),
  ]
  const recorded = finishReplay(
    atlas.replayAddressSteps(address, evidenceIdentity),
  )
  expect(recorded.steps).toHaveLength(4)
  expect(atlas.snapshot()).toHaveLength(1)
  expect(atlas.replayEvidence(recorded, evidenceIdentity).steps).toHaveLength(4)
})

test('exporting and freshly replaying evidence does not mutate an earlier immutable check report', () => {
  const atlas = evidenceFixture()
  const report = atlas.check(2)
  const before = JSON.stringify(report)
  const target = report.coverage.reached.states.at(-1)
  if (target === undefined) {
    throw new Error('Expected a checked state.')
  }
  const recorded = atlas.evidence(target, evidenceIdentity)
  const states = atlas.snapshot().length
  expect(
    atlas.replayEvidence(
      parseEvidence(serializeEvidence(recorded)),
      evidenceIdentity,
    ),
  ).toEqual(recorded)
  expect(JSON.stringify(report)).toBe(before)
  expect(Object.isFrozen(report)).toBe(true)
  expect(Object.isFrozen(report.coverage.edges)).toBe(true)
  expect(atlas.snapshot()).toHaveLength(states)
  expect(Schema.is(EvidenceArtifact)(recorded)).toBe(true)
})

test('an encoded undefined Message survives portable evidence replay', () => {
  const atlas = make(
    {
      name: 'Undefined evidence',
      Model: Schema.Number,
      Message: Schema.Undefined,
      start: () => ({ model: 0 }),
      update: (model: number) => ({ model: model + 1 }),
      view: (_model, h) => h.div([]),
    },
    {
      *starts() {},
      *next() {
        return send(undefined)
      },
    },
  )
  const address: Address = [
    { kind: 'Start', decisions: [], maybeMessage: Option.none() },
    { kind: 'Move', decisions: [], maybeMessage: Option.some(undefined) },
  ]
  const recorded = finishReplay(
    atlas.replayAddressSteps(address, evidenceIdentity),
  )
  const transition = recorded.steps[1]
  if (transition?._tag !== 'Move') {
    throw new Error('Expected undefined Move evidence.')
  }
  expect(transition.message).toEqual(EvidenceData.Undefined())
  expect(
    atlas.replayEvidence(
      parseEvidence(serializeEvidence(recorded)),
      evidenceIdentity,
    ),
  ).toEqual(recorded)
})

test('raw and encoded Message evidence remain separate for transformed codecs', () => {
  const atlas = make(
    {
      name: 'Encoded numbers',
      Model: Schema.Number,
      Message: Schema.NumberFromString,
      start: () => ({ model: 0 }),
      update: (_model: number, message) => ({ model: message }),
      view: (_model, h) => h.div([]),
    },
    {
      *starts() {},
      *next() {
        return send(1)
      },
    },
  )
  const address: Address = [
    { kind: 'Start', decisions: [], maybeMessage: Option.none() },
    { kind: 'Move', decisions: [], maybeMessage: Option.some('1') },
  ]
  const recorded = finishReplay(
    atlas.replayAddressSteps(address, evidenceIdentity),
  )
  const step = recorded.steps[1]
  if (step?._tag !== 'Move') {
    throw new Error('Expected transformed Message evidence.')
  }
  expect(step.message).toEqual(EvidenceData.Number({ value: '1' }))
  expect(step.encodedMessage).toEqual(EvidenceData.String({ value: '1' }))
  const altered = evidenceArtifact(evidenceIdentity, [
    ...recorded.steps.slice(0, 1),
    EvidenceStep.Move({
      ...step,
      message: EvidenceData.Number({ value: '99' }),
    }),
  ])
  expect(
    errorReason(() => atlas.replayEvidence(altered, evidenceIdentity)),
  ).toBe('evidence')
  expect(
    atlas.replayEvidence(
      parseEvidence(serializeEvidence(recorded)),
      evidenceIdentity,
    ),
  ).toEqual(recorded)
})

test('fresh evidence replay releases its owned generator on cancellation or disposal', () => {
  const calls = { opened: 0, closed: 0, started: 0 }
  const atlas = make(
    {
      name: 'Owned evidence replay',
      Model: Schema.Number,
      Message: Schema.Number,
      start: () => {
        calls.started += 1
        return { model: 0 }
      },
      update: (model: number) => ({ model }),
      view: (_model, h) => h.div([]),
    },
    {
      *starts() {
        calls.opened += 1
        try {
          for (const index of Array.range(0, 99)) {
            yield* fixture(String(index), { chosen: index })
          }
        } finally {
          calls.closed += 1
        }
      },
    },
  )
  const address: Address = [
    {
      kind: 'Start',
      decisions: Array.makeBy(100, index => ({
        fixture: String(index),
        option: 'chosen',
      })),
      maybeMessage: Option.none(),
    },
  ]
  const recorded = finishReplay(
    atlas.replayAddressSteps(address, evidenceIdentity),
  )
  expect(calls).toEqual({ opened: 1, closed: 1, started: 1 })
  const signal = new AbortController()
  const replay = atlas.replayEvidenceSteps(recorded, evidenceIdentity, {
    signal: signal.signal,
  })
  Array.makeBy(12, () => replay.next())
  expect(calls).toEqual({ opened: 2, closed: 1, started: 1 })
  signal.abort()
  expect(() => replay.next()).toThrow(ReplayCancelledError)
  expect(calls).toEqual({ opened: 2, closed: 2, started: 1 })
  const disposed: Iterator<void, EvidenceArtifact> = atlas.replayEvidenceSteps(
    recorded,
    evidenceIdentity,
  )
  Array.makeBy(12, () => disposed.next())
  disposed.return?.()
  expect(calls).toEqual({ opened: 3, closed: 3, started: 1 })
  expect(atlas.snapshot()).toHaveLength(1)
})

test('native Some round-trip preserves supported own value enumerability and execution identity', () => {
  const maybeValue = Option.some(1)
  Object.defineProperty(maybeValue, 'value', { enumerable: false })
  const restored = roundTrip(maybeValue)
  expect(Object.getOwnPropertyDescriptor(restored, 'value')?.enumerable).toBe(
    false,
  )
  const identity = makeIdentity()
  expect(identity.of(restored)).toBe(identity.of(maybeValue))
  expect(encodeEvidenceData(maybeValue)).not.toEqual(
    encodeEvidenceData(Option.some(1)),
  )
})

test('fresh evidence replay rejects a changed Some input value enumerability', () => {
  const create = (enumerable: boolean) => {
    const input = Option.some(1)
    Object.defineProperty(input, 'value', { enumerable })
    return make(
      {
        name: 'Some representation',
        Model: Schema.Number,
        Message: Schema.Number,
        start: (_input: Option.Option<number>) => ({ model: 0 }),
        update: (model: number) => ({ model }),
        view: (_model, h) => h.div([]),
      },
      {
        *starts() {
          return input
        },
      },
    )
  }
  const source = create(false)
  const address: Address = [
    { kind: 'Start', decisions: [], maybeMessage: Option.none() },
  ]
  const state = Option.getOrThrow(source.resolve(address))
  const recorded = parseEvidence(
    serializeEvidence(source.evidence(state, evidenceIdentity)),
  )
  expect(create(false).replayEvidence(recorded, evidenceIdentity)).toEqual(
    recorded,
  )
  expect(
    errorReason(() => create(true).replayEvidence(recorded, evidenceIdentity)),
  ).toBe('evidence')
})
