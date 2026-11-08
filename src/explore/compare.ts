import { Array } from 'effect'

import {
  type Environment,
  type Graph,
  type Limits,
  type Program,
  explore,
} from './explore'
import { keyOf } from './key'
import { type Screen, screenOf } from './screen'

export type Finding<Model = unknown> = Readonly<{
  kind: 'screen' | 'commands' | 'only-before' | 'only-after'
  // What each side shows. Moves only one side offers have one side.
  before?: string
  after?: string
  // The pair of states where it shows. Absent when the starts differ.
  states?: Readonly<{ before: Model; after: Model }>
  // How many pairs of states show this difference.
  count: number
  // The shortest way to reach one: the choices made at each step.
  path: ReadonlyArray<string>
}>

export type Comparison<Model = unknown> = Readonly<{
  findings: ReadonlyArray<Finding<Model>>
  pairs: number
  // False when either side was cut off. No findings then is not equivalence.
  isComplete: boolean
}>

// One side of a comparison: a graph of states with what each one shows.
export type Side<Model> = Readonly<{
  // The start states, by the choices that led to them.
  roots: ReadonlyMap<string, number>
  // Each state's moves, by the choices that made them, and where they lead.
  out: ReadonlyMap<number, ReadonlyMap<string, number>>
  screen: (id: number) => Screen
  commands: (id: number) => string
  // Absent when the side was loaded from a snapshot.
  model: (id: number) => Model | undefined
  isComplete: boolean
}>

const commandsOf = (
  pending: ReadonlyArray<Readonly<{ name: string; args?: unknown }>>,
): string => Array.map(pending, command => command.name).join(', ')

export const sideOf = <Model, Message, Input>(
  program: Program<Model, Message, Input>,
  graph: Graph<Model, Message, Input>,
): Side<Model> => {
  const out = new Map<number, Map<string, number>>()
  for (const edge of graph.edges) {
    out.set(
      edge.from,
      (out.get(edge.from) ?? new Map()).set(edge.via.join(' · '), edge.to),
    )
  }
  const screens = new Map<number, Screen>()
  return {
    roots: new Map(
      Array.map(
        Array.filter(graph.nodes, node => node.depth === 0),
        node => [node.via.join(' · '), node.id] as const,
      ),
    ),
    out,
    screen: id => {
      const known = screens.get(id)
      const node = graph.nodes[id]
      const screen =
        known ??
        (node === undefined
          ? { text: '', key: '' }
          : screenOf(program.view, node.model))
      screens.set(id, screen)
      return screen
    },
    commands: id => commandsOf(graph.nodes[id]?.pending ?? []),
    model: id => graph.nodes[id]?.model,
    isComplete: graph.isComplete,
  }
}

// Pairs the states of two sides by the choices that led to them. Differences
// are grouped; each keeps its shortest path.
export const diff = <Model>(
  left: Side<Model>,
  right: Side<Model>,
): Comparison<Model> => {
  const groups = new Map<string, Finding<Model>>()
  const note = (
    finding: Omit<Finding<Model>, 'count'>,
    identity: unknown,
  ): void => {
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
    states?: Finding<Model>['states'],
  ): void => {
    const next = Array.append(path, move)
    if (leftId === undefined || rightId === undefined) {
      note(
        leftId === undefined
          ? {
              kind: 'only-after',
              after: move,
              path: next,
              ...(states && { states }),
            }
          : {
              kind: 'only-before',
              before: move,
              path: next,
              ...(states && { states }),
            },
        [move, leftId === undefined],
      )
      return
    }
    if (!seen.has(`${leftId}:${rightId}`)) {
      seen.add(`${leftId}:${rightId}`)
      queue.push({ left: leftId, right: rightId, path: next })
    }
  }

  for (const move of new Set([...left.roots.keys(), ...right.roots.keys()])) {
    pair(left.roots.get(move), right.roots.get(move), [], move)
  }

  for (const current of queue) {
    const x = left.screen(current.left)
    const y = right.screen(current.right)
    const a = left.model(current.left)
    const b = right.model(current.right)
    const states =
      a === undefined || b === undefined ? undefined : { before: a, after: b }
    if (x.key !== y.key) {
      note(
        {
          kind: 'screen',
          before: x.text,
          after: y.text,
          path: current.path,
          ...(states && { states }),
        },
        [x.key, y.key],
      )
    }
    const [c, d] = [left.commands(current.left), right.commands(current.right)]
    if (c !== d) {
      note(
        {
          kind: 'commands',
          before: c,
          after: d,
          path: current.path,
          ...(states && { states }),
        },
        [c, d],
      )
    }
    const moves = left.out.get(current.left) ?? new Map<string, number>()
    const others = right.out.get(current.right) ?? new Map<string, number>()
    for (const move of new Set([...moves.keys(), ...others.keys()])) {
      pair(moves.get(move), others.get(move), current.path, move, states)
    }
  }
  return {
    findings: [...groups.values()],
    pairs: seen.size,
    isComplete: left.isComplete && right.isComplete,
  }
}

// Runs both versions in the same environment and diffs what they reach.
export const compare = <Model, Message, Input>(
  before: Program<Model, Message, Input>,
  after: Program<Model, Message, Input>,
  environment: Environment<Model, Message, Input>,
  limits: Limits,
): Comparison<Model> =>
  diff(
    sideOf(before, explore(before, environment, limits)),
    sideOf(after, explore(after, environment, limits)),
  )
