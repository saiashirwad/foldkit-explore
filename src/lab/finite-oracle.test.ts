// @vitest-environment node

import { Array, Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import { expect, test, vi } from 'vitest'

import {
  type Atlas,
  type Environment,
  type NextState,
  type Program,
  type Property,
  answer,
  make,
  send,
} from './atlas'
import {
  type Comparison,
  type ComparisonExample,
  type ComparisonLimits,
  compare,
} from './compare'
import {
  type ReferenceGraph,
  type ReferencePairEdge,
  type TableMessage,
  type TransitionTable,
  referenceApply,
  referenceCompare,
  referenceExplore,
  referenceKey,
  seededTable,
} from './finite-oracle'
import { fixture } from './fixture'
import * as Interactions from './interactions'

const Message = Schema.Struct({
  event: Schema.Number,
  target: Schema.Number,
  issued: Schema.Array(Schema.Number),
})
const Request = Command.define('OracleRequest', {
  args: { value: Schema.Number },
  messages: [Message],
  execute: () => Effect.die('Oracle Commands must not execute'),
})
const issued = (values: ReadonlyArray<number>) =>
  values.map(value => Request({ value }))
const limits = { states: 1_000, transitions: 20_000, enumerationWork: 200_000 }
const properties = (
  unsafe: number,
): ReadonlyArray<Property<number, TableMessage>> => [
  { id: 'state', name: 'Safe state', state: state => state.model !== unsafe },
  {
    id: 'transition',
    name: 'Safe transition',
    transition: (_before, message) => message.target !== unsafe,
  },
]
const program = (
  table: TransitionTable,
): Program<number, TableMessage, number> => ({
  name: 'Finite table',
  Model: Schema.Number,
  Message,
  start: input => ({ model: input, commands: issued(table.initialPending) }),
  update: (_model, message) => ({
    model: message.target,
    commands: issued(message.issued),
  }),
  view: (model, h) => h.p([], [String(model)]),
})
const environment = (
  table: TransitionTable,
): Environment<number, TableMessage, number> => ({
  *starts() {
    return yield* fixture(
      'start',
      Object.fromEntries(
        table.starts.map((input, index) => [String(index), input]),
      ),
    )
  },
  *next(state) {
    const edges = (table.edges[state.model] ?? []).filter(
      edge => edge.request === undefined || edge.request < state.pending.length,
    )
    const selected = yield* fixture(
      'event',
      Object.fromEntries(edges.map(edge => [edge.label, edge])),
    )
    if (selected.request === undefined) {
      return send(selected.message)
    }
    const command = state.pending[selected.request]
    if (command === undefined) {
      throw new Error('Missing selected request')
    }
    return answer({ index: selected.request, command }, selected.message)
  },
})
const pendingValues = (
  pending: ReadonlyArray<{ args: unknown }>,
): ReadonlyArray<number> =>
  pending.map(
    command =>
      Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Number }))(
        command.args,
      ).value,
  )
const actualKey = (atlas: Atlas, id: string): string => {
  const frame = atlas.trace(id)[0]
  const decision = atlas.address(id)[0]?.decisions[0]
  if (frame === undefined || decision === undefined) {
    throw new Error('Missing table root')
  }
  const input = Schema.decodeUnknownSync(Schema.Number)(atlas.encode(frame.to))
  const pending = atlas
    .pending(id)
    .map(command => JSON.parse(command.args).value)
  return referenceKey({
    input,
    model: Schema.decodeUnknownSync(Schema.Number)(atlas.encode(id)),
    pending,
  })
}
const actualGraph = (atlas: Atlas, depth: number): ReferenceGraph => {
  const report = atlas.check(depth, limits)
  return {
    states: report.coverage.reached.states
      .map(id => actualKey(atlas, id))
      .sort(),
    edges: report.coverage.edges.map(edge => ({
      from: actualKey(atlas, edge.from),
      to: actualKey(atlas, edge.step.to),
      label: edge.step.label.replace(/^OracleRequest #\d+ /, ''),
      event: '',
      depth: atlas.trace(edge.from).length,
    })),
    violations: report.violations.map(violation => ({
      property: violation.propertyId,
      depth: violation.trace.length - 1,
    })),
    frontier: report.coverage.frontier.map(id => actualKey(atlas, id)).sort(),
    complete: report.coverage.reached.status === 'complete',
  }
}
const edgeKeys = (graph: ReferenceGraph): ReadonlyArray<string> =>
  graph.edges
    .map(edge => JSON.stringify([edge.from, edge.label, edge.to]))
    .sort()
const assertGraph = (actual: ReferenceGraph, expected: ReferenceGraph) => {
  expect(actual.states).toEqual(expected.states)
  expect(edgeKeys(actual)).toEqual(edgeKeys(expected))
  expect(
    actual.violations
      .slice()
      .sort((a, b) => a.property.localeCompare(b.property)),
  ).toEqual(
    expected.violations
      .slice()
      .sort((a, b) => a.property.localeCompare(b.property)),
  )
  expect(actual.frontier).toEqual(expected.frontier)
  expect(actual.complete).toBe(expected.complete)
}

const seeds = [1, 2, 3, 17, 42, 99, 1234, 0xdeadbeef]
test.each(seeds)(
  'finite oracle seed %i: BFS/DFS, budgets, resumption and run isolation',
  seed => {
    const table = seededTable(seed)
    const expected = referenceExplore(table)
    const atlas = make(program(table), environment(table), {
      properties: properties(table.unsafe),
    })
    const small = atlas.check(0, {
      states: 1,
      transitions: 2,
      enumerationWork: 8,
    })
    const savedSmall = JSON.stringify(small)
    const complete = actualGraph(atlas, 20)
    assertGraph(complete, expected)
    const revisited = complete.edges.find(edge => edge.from === edge.to)
    expect(revisited).toBeDefined()
    expect(() =>
      assertGraph(
        {
          ...complete,
          edges: complete.edges.filter(edge => edge !== revisited),
        },
        expected,
      ),
    ).toThrow()
    const depth = atlas.reach(20, 'depth', limits)
    expect(depth.status).toBe('complete')
    expect(depth.states.map(id => actualKey(atlas, id)).sort()).toEqual(
      expected.states,
    )
    const depthEdges = depth.states
      .flatMap(from =>
        atlas
          .successors(from)
          .map(step =>
            JSON.stringify([
              actualKey(atlas, from),
              step.label,
              actualKey(atlas, step.to),
            ]),
          ),
      )
      .sort()
    expect(depthEdges).toEqual(edgeKeys(expected))
    expect(JSON.stringify(small)).toBe(savedSmall)
    expect(
      JSON.stringify(
        atlas.check(0, { states: 1, transitions: 2, enumerationWork: 8 }),
      ),
    ).toBe(savedSmall)
    const fresh = make(program(table), environment(table), {
      properties: properties(table.unsafe),
    })
    assertGraph(actualGraph(fresh, 20), actualGraph(atlas, 20))
    assertGraph(actualGraph(atlas, 0), referenceExplore(table, 0))
    const fixed = atlas.check(20, limits)
    const serialized = JSON.stringify(fixed)
    const root = Option.getOrThrow(Array.head(fixed.coverage.reached.states))
    Array.range(1, 3).forEach(() =>
      atlas.interact(root, { event: 100, target: 10, issued: [] }),
    )
    expect(JSON.stringify(fixed)).toBe(serialized)
    assertGraph(actualGraph(atlas, 20), expected)
    atlas.dispose()
    fresh.dispose()
  },
)

const protocol: TransitionTable = {
  starts: [0, 0],
  initialPending: [7, 8, 7],
  unsafe: 2,
  edges: [
    [
      {
        label: 'first duplicate',
        request: 0,
        message: { event: 1, target: 1, issued: [] },
      },
      {
        label: 'last duplicate',
        request: 2,
        message: { event: 2, target: 1, issued: [] },
      },
    ],
    [
      {
        label: 'consume remaining',
        request: 0,
        message: { event: 3, target: 2, issued: [] },
      },
    ],
    [],
  ],
}
test('reference pending protocol distinguishes duplicate occurrences and catches injected mutations', () => {
  const atlas = make(program(protocol), environment(protocol), {
    properties: properties(protocol.unsafe),
  })
  const expected = referenceExplore(protocol)
  const actual = actualGraph(atlas, 10)
  assertGraph(actual, expected)
  expect(() =>
    assertGraph({ ...actual, edges: actual.edges.slice(1) }, expected),
  ).toThrow()
  const first = expected.edges.find(edge => edge.label === 'last duplicate')
  expect(first).toBeDefined()
  const wrong = referenceApply(
    { input: 0, model: 0, pending: [7, 8, 7] },
    {
      label: 'wrong',
      request: 0,
      message: { event: 2, target: 1, issued: [] },
    },
  )
  expect(first?.to).not.toBe(referenceKey(wrong))
  expect(() =>
    assertGraph(
      {
        ...actual,
        states: actual.states.map(key =>
          key === first?.to ? referenceKey(wrong) : key,
        ),
      },
      expected,
    ),
  ).toThrow()
  const limited = actualGraph(atlas, 0)
  expect(() =>
    assertGraph(
      { ...limited, complete: true, frontier: [] },
      referenceExplore(protocol, 0),
    ),
  ).toThrow()
  atlas.dispose()
})

test('finite oracle follows newly issued work after a selected duplicate reply', () => {
  const table: TransitionTable = {
    starts: [0],
    initialPending: [7, 8, 7],
    unsafe: 3,
    edges: [
      [
        {
          label: 'reply and issue',
          request: 2,
          message: { event: 1, target: 1, issued: [9] },
        },
      ],
      [
        {
          label: 'new reply',
          request: 2,
          message: { event: 2, target: 2, issued: [] },
        },
      ],
      [
        {
          label: 'old reply',
          request: 0,
          message: { event: 3, target: 3, issued: [] },
        },
      ],
      [],
    ],
  }
  const atlas = make(program(table), environment(table), {
    properties: properties(table.unsafe),
  })
  assertGraph(actualGraph(atlas, 10), referenceExplore(table))
  const report = atlas.check(10)
  expect(report.coverage.edges[0]?.evidence.issued).toEqual([
    { name: 'OracleRequest', args: { value: 9 } },
  ])
  expect(
    Option.getOrThrow(
      report.coverage.edges[0]?.evidence.maybeRequest ?? Option.none(),
    ),
  ).toMatchObject({ index: 2, occurrence: 1 })
  expect(
    report.coverage.reached.states.map(id => actualKey(atlas, id)),
  ).toEqual(['[0,0,[7,8,7]]', '[0,1,[7,8,9]]', '[0,2,[7,8]]', '[0,3,[8]]'])
  atlas.dispose()
})

const PairModel = Schema.Struct({
  node: Schema.Number,
  side: Schema.Literals(['before', 'after']),
})
type PairModel = typeof PairModel.Type
const pairProgram = (
  table: TransitionTable,
  side: PairModel['side'],
): Program<PairModel, TableMessage, number> => ({
  name: side,
  Model: PairModel,
  Message,
  start: input => ({
    model: { node: input, side },
    commands: issued(table.initialPending),
  }),
  update: (_model, message) => ({
    model: {
      node:
        table.edges.flat().find(edge => edge.message.event === message.event)
          ?.next ?? message.target,
      side,
    },
    commands: issued(message.issued),
  }),
  view: (model, h) => h.p([], [`${side}:${model.node}`]),
})
const pairEnvironment = (
  before: TransitionTable,
  after: TransitionTable,
): Environment<PairModel, TableMessage, number> => ({
  *starts() {
    return yield* fixture(
      'start',
      Object.fromEntries(
        before.starts.map((input, index) => [String(index), input]),
      ),
    )
  },
  *next(state) {
    const table = state.model.side === 'before' ? before : after
    const selected = yield* fixture(
      'event',
      Object.fromEntries(
        (table.edges[state.model.node] ?? [])
          .filter(
            edge =>
              edge.request === undefined || edge.request < state.pending.length,
          )
          .map(edge => [edge.label, edge]),
      ),
    )
    if (selected.request === undefined) {
      return send(selected.message)
    }
    const command = state.pending[selected.request]
    if (command === undefined) {
      throw new Error('Missing pair request')
    }
    return answer({ index: selected.request, command }, selected.message)
  },
})
const executionKey = (execution: {
  input: unknown
  model: unknown
  pending: ReadonlyArray<{ args: unknown }>
}): string =>
  referenceKey({
    input: Schema.decodeUnknownSync(Schema.Number)(execution.input),
    model: Schema.decodeUnknownSync(PairModel)(execution.model).node,
    pending: pendingValues(execution.pending),
  })
const pairEdges = (
  comparison: Comparison,
): ReadonlyArray<ReferencePairEdge> => {
  const examples = new Map<string, ComparisonExample>()
  comparison.findings.forEach(finding =>
    finding.examples.forEach(example => examples.set(example.id, example)),
  )
  return [...examples.values()].flatMap(example => {
    const frame = example.trace.at(-1)
    const previous = example.trace.at(-2)
    const event = frame?.beforeEvent ?? frame?.afterEvent
    if (
      frame === undefined ||
      previous?.before === undefined ||
      previous.after === undefined ||
      event === undefined
    ) {
      return []
    }
    const first = example.trace[0]
    const context = Number(first?.startDecisions[0]?.option)
    const source = JSON.stringify([
      context,
      executionKey(previous.before),
      executionKey(previous.after),
    ])
    const offered =
      event.kind === 'Move'
        ? JSON.stringify(['move', event.message])
        : JSON.stringify([
            'answer',
            Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Number }))(
              event.request?.command.args,
            ).value,
            event.request?.occurrence,
            event.message,
          ])
    return [
      {
        source,
        event: offered,
        ...(frame.before === undefined
          ? {}
          : { before: executionKey(frame.before) }),
        ...(frame.after === undefined
          ? {}
          : { after: executionKey(frame.after) }),
      },
    ]
  })
}
const sortedPairEdges = (edges: ReadonlyArray<ReferencePairEdge>) =>
  edges.map(edge => JSON.stringify(edge)).sort()
const pairedBounds: ComparisonLimits = { depth: 20, ...limits, pairs: 1_000 }
const runPair = (
  before: TransitionTable,
  after: TransitionTable,
  bounds = pairedBounds,
) =>
  compare({
    before: pairProgram(before, 'before'),
    after: pairProgram(after, 'after'),
    environment: pairEnvironment(before, after),
    limits: bounds,
  })

test('paired oracle covers revisited edges, duplicate roots, replies and one-sided-stop replay', () => {
  const after = {
    ...protocol,
    edges: protocol.edges.map((edges, index) =>
      index === 0 ? edges.slice(0, 1) : edges,
    ),
  }
  const expected = referenceCompare(protocol, after)
  const result = runPair(protocol, after, {
    ...pairedBounds,
    depth: 0,
    transitions: 2,
    enumerationWork: 8,
  })
  expect(result.status).not.toBe('complete')
  result.resume(pairedBounds)
  expect(result.status).toBe('complete')
  expect(result.counters.pairs).toBe(expected.pairs.length)
  expect(sortedPairEdges(pairEdges(result))).toEqual(
    sortedPairEdges(expected.edges),
  )
  const fresh = runPair(protocol, after)
  expect(sortedPairEdges(pairEdges(fresh))).toEqual(
    sortedPairEdges(expected.edges),
  )
  result.findings.forEach(finding =>
    finding.examples.forEach(example => {
      const replayed = result.replay(example.trace)
      expect(
        replayed.map(frame => [
          frame.before?.model,
          frame.after?.model,
          frame.beforeIssued,
          frame.afterIssued,
        ]),
      ).toEqual(
        example.trace.map(frame => [
          frame.before?.model,
          frame.after?.model,
          frame.beforeIssued,
          frame.afterIssued,
        ]),
      )
    }),
  )
  expect(() => result.resume({ ...pairedBounds, depth: 0 })).toThrow(
    'cannot decrease',
  )
  result.dispose()
  fresh.dispose()
})

test('both paired checkers reject ambiguous duplicate semantic alternatives', () => {
  const table = seededTable(42)
  expect(() => referenceCompare(table, table)).toThrow(
    'duplicate semantic events',
  )
  expect(() => runPair(table, table)).toThrow('Duplicate comparison event key')
})

test.each(seeds)(
  'paired oracle seed %i preserves independent matching and stopping semantics',
  seed => {
    const generated = seededTable(seed)
    const before: TransitionTable = {
      ...generated,
      edges: generated.edges.map(edges =>
        edges.filter(
          (edge, index) =>
            edges.findIndex(
              candidate => candidate.message.event === edge.message.event,
            ) === index,
        ),
      ),
    }
    const after: TransitionTable = {
      ...before,
      edges: before.edges.map((edges, index) =>
        index === 0 ? edges.filter(edge => edge.label !== 'right') : edges,
      ),
    }
    const expected = referenceCompare(before, after)
    const result = runPair(before, after)
    expect(result.status).toBe('complete')
    expect(result.counters.pairs).toBe(expected.pairs.length)
    expect(sortedPairEdges(pairEdges(result))).toEqual(
      sortedPairEdges(expected.edges),
    )
    result.dispose()
  },
)

const fanout = (width: number): TransitionTable => ({
  starts: [0],
  initialPending: [],
  unsafe: -1,
  edges: [
    Array.range(1, width).map(event => ({
      label: String(event),
      message: { event, target: event, issued: [] },
    })),
    ...Array.makeBy(width, () => []),
  ],
})
test('join bookkeeping grows exactly linearly with matched event width', () => {
  const measured = [32, 64, 128].map(width => {
    const table = fanout(width)
    const result = runPair(table, table)
    expect(result.status).toBe('complete')
    expect(result.counters.joinOperations).toBe(8 * width)
    expect(result.counters.transitions).toBe(1 + 2 * width)
    const operations = result.counters.joinOperations
    result.dispose()
    return operations
  })
  expect(measured).toEqual([256, 512, 1024])
})

test('many pairs sharing one side measure physical enumeration/update/inspection versus logical edges', () => {
  const width = 16
  const table = fanout(width)
  const before: TransitionTable = {
    ...table,
    edges: [table.edges[0]?.map(edge => ({ ...edge, next: 0 })) ?? []],
  }
  const counts = {
    nextBefore: 0,
    nextAfter: 0,
    updateBefore: 0,
    updateAfter: 0,
    logicalEdges: 0,
  }
  const beforeProgram = pairProgram(before, 'before')
  const afterProgram = pairProgram(table, 'after')
  const shared = pairEnvironment(before, table)
  const inspect = vi.spyOn(Interactions, 'inspect')
  const measuredEnvironment: Environment<PairModel, TableMessage, number> = {
    starts: shared.starts,
    *next(state: NextState<PairModel, TableMessage, number>) {
      if (state.model.side === 'before') {
        counts.nextBefore += 1
      } else {
        counts.nextAfter += 1
      }
      return yield* Option.getOrThrow(Option.fromUndefinedOr(shared.next))(
        state,
      )
    },
  }
  const result = compare({
    before: {
      ...beforeProgram,
      update: (model, message) => {
        counts.updateBefore += 1
        return beforeProgram.update(model, message)
      },
    },
    after: {
      ...afterProgram,
      update: (model, message) => {
        counts.updateAfter += 1
        return afterProgram.update(model, message)
      },
    },
    environment: measuredEnvironment,
    limits: pairedBounds,
    properties: [
      {
        id: 'every-edge',
        name: 'Every edge',
        transition: () => {
          counts.logicalEdges += 1
          return true
        },
      },
    ],
  })
  try {
    expect(result.status).toBe('complete')
    const expected = referenceCompare(before, table)
    expect(sortedPairEdges(pairEdges(result))).toEqual(
      sortedPairEdges(expected.edges),
    )
    expect(counts).toEqual({
      nextBefore: (width + 1) ** 2,
      nextAfter: 2 * width + 1,
      updateBefore: width * (width + 1),
      updateAfter: width,
      logicalEdges: width * (width + 2),
    })
    expect(inspect).toHaveBeenCalledTimes(width + 2)
    expect(result.counters.joinOperations).toBe(8 * width + 5 * width * width)
  } finally {
    inspect.mockRestore()
    result.dispose()
  }
})
