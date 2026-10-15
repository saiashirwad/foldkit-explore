export type TableMessage = Readonly<{
  event: number
  target: number
  issued: ReadonlyArray<number>
}>
type TableEdge = Readonly<{
  label: string
  message: TableMessage
  request?: number
  next?: number
}>
export type TransitionTable = Readonly<{
  starts: ReadonlyArray<number>
  initialPending: ReadonlyArray<number>
  edges: ReadonlyArray<ReadonlyArray<TableEdge>>
  unsafe: number
}>
type ReferenceState = Readonly<{
  input: number
  model: number
  pending: ReadonlyArray<number>
}>
type ReferenceEdge = Readonly<{
  from: string
  to: string
  label: string
  event: string
  depth: number
}>
export type ReferenceGraph = Readonly<{
  states: ReadonlyArray<string>
  edges: ReadonlyArray<ReferenceEdge>
  violations: ReadonlyArray<Readonly<{ property: string; depth: number }>>
  frontier: ReadonlyArray<string>
  complete: boolean
}>

export const referenceKey = (state: ReferenceState): string =>
  JSON.stringify([state.input, state.model, state.pending])

const referenceEvents = (
  table: TransitionTable,
  state: ReferenceState,
): ReadonlyArray<TableEdge> =>
  (table.edges[state.model] ?? []).filter(
    edge => edge.request === undefined || edge.request < state.pending.length,
  )

const referenceEvent = (state: ReferenceState, edge: TableEdge): string => {
  if (edge.request === undefined) {
    return JSON.stringify(['move', edge.message])
  }
  const argument = state.pending[edge.request]
  const occurrence = state.pending
    .slice(0, edge.request)
    .filter(candidate => candidate === argument).length
  return JSON.stringify(['answer', argument, occurrence, edge.message])
}

export const referenceApply = (
  state: ReferenceState,
  edge: TableEdge,
): ReferenceState => ({
  input: state.input,
  model: edge.next ?? edge.message.target,
  pending: state.pending
    .filter((_argument, index) => index !== edge.request)
    .concat(edge.message.issued),
})

export const referenceExplore = (
  table: TransitionTable,
  depth = 100,
): ReferenceGraph => {
  const seen = new Map<string, ReferenceState>()
  const queue: Array<{ state: ReferenceState; depth: number }> = []
  const edges: Array<ReferenceEdge> = []
  const failures = new Map<string, number>()
  const frontier: Array<string> = []
  const admit = (state: ReferenceState, distance: number) => {
    const key = referenceKey(state)
    if (!seen.has(key)) {
      seen.set(key, state)
      queue.push({ state, depth: distance })
      if (state.model === table.unsafe && !failures.has('state')) {
        failures.set('state', distance)
      }
    }
  }
  table.starts.forEach(input => {
    admit({ input, model: input, pending: table.initialPending }, 0)
  })
  const position = { index: 0 }
  while (position.index < queue.length) {
    const entry = queue[position.index++]
    if (entry === undefined) {
      throw new Error('Reference queue is inconsistent')
    }
    const candidates = referenceEvents(table, entry.state)
    if (entry.depth >= depth && candidates.length !== 0) {
      frontier.push(referenceKey(entry.state))
      continue
    }
    candidates.forEach(edge => {
      const target = referenceApply(entry.state, edge)
      edges.push({
        from: referenceKey(entry.state),
        to: referenceKey(target),
        label: edge.label,
        event: referenceEvent(entry.state, edge),
        depth: entry.depth + 1,
      })
      if (edge.message.target === table.unsafe && !failures.has('transition')) {
        failures.set('transition', entry.depth + 1)
      }
      admit(target, entry.depth + 1)
    })
  }
  return {
    states: [...seen.keys()].sort(),
    edges,
    violations: [...failures].map(([property, distance]) => ({
      property,
      depth: distance,
    })),
    frontier: frontier.sort(),
    complete: frontier.length === 0,
  }
}

type ReferencePair = Readonly<{
  context: number
  before: ReferenceState
  after: ReferenceState
  depth: number
}>
export type ReferencePairEdge = Readonly<{
  source: string
  event: string
  before?: string
  after?: string
}>
type ReferenceComparison = Readonly<{
  pairs: ReadonlyArray<string>
  edges: ReadonlyArray<ReferencePairEdge>
}>
const referencePairKey = (pair: ReferencePair): string =>
  JSON.stringify([
    pair.context,
    referenceKey(pair.before),
    referenceKey(pair.after),
  ])

export const referenceCompare = (
  before: TransitionTable,
  after: TransitionTable,
): ReferenceComparison => {
  const pairs = new Map<string, ReferencePair>()
  const edges: Array<ReferencePairEdge> = []
  const queue: Array<ReferencePair> = []
  const admit = (pair: ReferencePair) => {
    const key = referencePairKey(pair)
    if (!pairs.has(key)) {
      pairs.set(key, pair)
      queue.push(pair)
    }
  }
  before.starts.forEach((input, context) => {
    admit({
      context,
      before: { input, model: input, pending: before.initialPending },
      after: { input, model: input, pending: after.initialPending },
      depth: 0,
    })
  })
  const cursor = { index: 0 }
  while (cursor.index < queue.length) {
    const pair = queue[cursor.index++]
    if (pair === undefined) {
      throw new Error('Reference pair queue is inconsistent')
    }
    const beforeEvents = referenceEvents(before, pair.before)
    const afterEvents = referenceEvents(after, pair.after)
    const left = new Map(
      beforeEvents.map(edge => [referenceEvent(pair.before, edge), edge]),
    )
    const right = new Map(
      afterEvents.map(edge => [referenceEvent(pair.after, edge), edge]),
    )
    if (
      left.size !== beforeEvents.length ||
      right.size !== afterEvents.length
    ) {
      throw new Error('Reference comparison has duplicate semantic events')
    }
    new Set([...left.keys(), ...right.keys()]).forEach(event => {
      const beforeEdge = left.get(event)
      const afterEdge = right.get(event)
      const nextBefore =
        beforeEdge === undefined
          ? undefined
          : referenceApply(pair.before, beforeEdge)
      const nextAfter =
        afterEdge === undefined
          ? undefined
          : referenceApply(pair.after, afterEdge)
      edges.push({
        source: referencePairKey(pair),
        event,
        ...(nextBefore === undefined
          ? {}
          : { before: referenceKey(nextBefore) }),
        ...(nextAfter === undefined ? {} : { after: referenceKey(nextAfter) }),
      })
      if (nextBefore !== undefined && nextAfter !== undefined) {
        admit({
          context: pair.context,
          before: nextBefore,
          after: nextAfter,
          depth: pair.depth + 1,
        })
      }
    })
  }
  return { pairs: [...pairs.keys()].sort(), edges }
}

export const seededTable = (seed: number): TransitionTable => {
  const random = { value: seed >>> 0 }
  const next = () => {
    random.value = (Math.imul(random.value, 1664525) + 1013904223) >>> 0
    return random.value
  }
  const edge = (label: string, event: number, target: number): TableEdge => ({
    label,
    message: { event, target, issued: [] },
  })
  return {
    starts: [0, 1, 0],
    initialPending: [],
    unsafe: 3,
    edges: [
      [edge('left', 1, 1), edge('right', 2, 2), edge('repeat', 1, 1)],
      [edge('merge', 3, 3), edge('self', 4, 1), edge('seed', 5, next() % 5)],
      [edge('merge', 3, 3), edge('cycle', 6, 0)],
      [edge('terminal', 7, 4)],
      [],
    ],
  }
}
