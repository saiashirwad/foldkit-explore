import { Array } from 'effect'

import {
  type Environment,
  type Graph,
  type Limits,
  type Program,
  explore,
} from './explore'
import { keyOf } from './key'
import { screenOf } from './screen'

export type Finding = Readonly<{
  kind: 'screen' | 'commands' | 'only-before' | 'only-after'
  // What each side shows. Moves only one side offers have one side.
  before?: string
  after?: string
  // How many pairs of states show this difference.
  count: number
  // The shortest way to reach one: the choices made at each step.
  path: ReadonlyArray<string>
}>

export type Comparison = Readonly<{
  findings: ReadonlyArray<Finding>
  pairs: number
  // False when either side was cut off. No findings then is not equivalence.
  isComplete: boolean
}>

const outgoing = <Model, Message, Input>(
  graph: Graph<Model, Message, Input>,
): ReadonlyMap<number, ReadonlyMap<string, number>> => {
  const byNode = new Map<number, Map<string, number>>()
  for (const edge of graph.edges) {
    byNode.set(
      edge.from,
      (byNode.get(edge.from) ?? new Map()).set(edge.via.join(' · '), edge.to),
    )
  }
  return byNode
}

const commandsOf = (
  pending: ReadonlyArray<Readonly<{ name: string; args?: unknown }>>,
): string => Array.map(pending, command => command.name).join(', ')

// Runs both versions in the same environment and pairs their states by the
// choices that led to them. Differences are grouped; each keeps its shortest
// path.
export const compare = <Model, Message, Input>(
  before: Program<Model, Message, Input>,
  after: Program<Model, Message, Input>,
  environment: Environment<Model, Message, Input>,
  limits: Limits,
): Comparison => {
  const left = explore(before, environment, limits)
  const right = explore(after, environment, limits)
  const leftEdges = outgoing(left)
  const rightEdges = outgoing(right)
  const groups = new Map<string, Finding>()
  const note = (finding: Omit<Finding, 'count'>, identity: unknown): void => {
    const id = keyOf([finding.kind, identity])
    const known = groups.get(id)
    groups.set(id, { ...(known ?? finding), count: (known?.count ?? 0) + 1 })
  }

  const seen = new Set<string>()
  const queue: Array<
    Readonly<{ left: number; right: number; path: ReadonlyArray<string> }>
  > = []
  const pair = (
    leftId: number | undefined,
    rightId: number | undefined,
    path: ReadonlyArray<string>,
    move: string,
  ): void => {
    const next = Array.append(path, move)
    if (leftId === undefined || rightId === undefined) {
      const text = `${move}`
      note(
        leftId === undefined
          ? { kind: 'only-after', after: text, path: next }
          : { kind: 'only-before', before: text, path: next },
        [text, leftId === undefined],
      )
      return
    }
    if (!seen.has(`${leftId}:${rightId}`)) {
      seen.add(`${leftId}:${rightId}`)
      queue.push({ left: leftId, right: rightId, path: next })
    }
  }

  const roots = (graph: typeof left) =>
    new Map(
      Array.map(
        Array.filter(graph.nodes, node => node.depth === 0),
        node => [node.via.join(' · '), node.id] as const,
      ),
    )
  const leftRoots = roots(left)
  const rightRoots = roots(right)
  for (const move of new Set([...leftRoots.keys(), ...rightRoots.keys()])) {
    pair(leftRoots.get(move), rightRoots.get(move), [], move)
  }

  for (const current of queue) {
    const a = left.nodes[current.left]
    const b = right.nodes[current.right]
    if (a === undefined || b === undefined) {
      continue
    }
    const screens = [
      screenOf(before.view, a.model),
      screenOf(after.view, b.model),
    ]
    const [x, y] = screens
    if (x !== undefined && y !== undefined && x.key !== y.key) {
      note(
        { kind: 'screen', before: x.text, after: y.text, path: current.path },
        [x.key, y.key],
      )
    }
    const [c, d] = [commandsOf(a.pending), commandsOf(b.pending)]
    if (c !== d) {
      note({ kind: 'commands', before: c, after: d, path: current.path }, [
        c,
        d,
      ])
    }
    const moves = new Map(leftEdges.get(a.id))
    const others = new Map(rightEdges.get(b.id))
    for (const move of new Set([...moves.keys(), ...others.keys()])) {
      pair(moves.get(move), others.get(move), current.path, move)
    }
  }
  return {
    findings: [...groups.values()],
    pairs: seen.size,
    isComplete: left.isComplete && right.isComplete,
  }
}
