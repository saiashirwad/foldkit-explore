import { Array, Predicate, type Schema } from 'effect'

import {
  type Environment,
  type Graph,
  type Limits,
  type Program,
  type State,
  explore,
} from './explore'

export type Violation = Readonly<{
  id: number
  // The choices made at each step, from a start to the state.
  path: ReadonlyArray<string>
}>

// The choices made at each step from a start to a state, shortest first.
export const pathTo = <Model, Message, Input>(
  graph: Graph<Model, Message, Input>,
  id: number,
): ReadonlyArray<string> => {
  const path: Array<string> = []
  for (
    let node = graph.nodes[id];
    node !== undefined;
    node = node.parent === undefined ? undefined : graph.nodes[node.parent]
  ) {
    path.unshift(node.via.join(' · '))
  }
  return path
}

// The explored states where `holds` is false. Discovery is breadth first, so
// each path is a shortest one. An empty result only covers what was explored:
// check `graph.isComplete`.
export const violations = <Model, Message, Input>(
  graph: Graph<Model, Message, Input>,
  holds: (state: State<Model, Message, Input>) => boolean,
): ReadonlyArray<Violation> =>
  Array.map(
    Array.filter(graph.nodes, node => !holds(node)),
    node => ({ id: node.id, path: pathTo(graph, node.id) }),
  )

// States with no move to a different state. A state at the depth limit was not
// expanded, so it is not one. Some are fine, such as a finished signup.
export const deadEnds = <Model, Message, Input>(
  graph: Graph<Model, Message, Input>,
  depth: number,
): ReadonlyArray<Violation> => {
  const exits = new Set(
    Array.map(
      Array.filter(graph.edges, edge => edge.from !== edge.to),
      edge => edge.from,
    ),
  )
  return Array.map(
    Array.filter(
      graph.nodes,
      node => node.depth < depth && !exits.has(node.id),
    ),
    node => ({ id: node.id, path: pathTo(graph, node.id) }),
  )
}

export type Found<Model> = Readonly<{
  path: ReadonlyArray<string>
  model: Model
}>

// The shortest way to a state `goal` accepts, or undefined if none was found.
// The search stops at the first match, so it can go deeper than a full one.
// `isComplete` on the result says whether a miss covers every reachable state.
export const find = <Model, Message, Input>(
  program: Program<Model, Message, Input>,
  environment: Environment<Model, Message, Input>,
  goal: (state: State<Model, Message, Input>) => boolean,
  limits: Limits,
): Readonly<{ found: Found<Model> | undefined; isComplete: boolean }> => {
  const graph = explore(program, environment, limits, goal)
  const node = graph.found === undefined ? undefined : graph.nodes[graph.found]
  return {
    found:
      node === undefined
        ? undefined
        : { path: pathTo(graph, node.id), model: node.model },
    isComplete: graph.isComplete,
  }
}

// The `_tag` of each variant of a Message union.
export const tagsOf = (message: Schema.Top): ReadonlyArray<string> =>
  Array.flatMap(
    Predicate.hasProperty(message.ast, 'types')
      ? Array.ensure(Reflect.get(message.ast, 'types'))
      : [],
    member =>
      Array.flatMap(
        Array.ensure(Reflect.get(member, 'propertySignatures') ?? []),
        signature =>
          Reflect.get(signature, 'name') === '_tag' &&
          typeof Reflect.get(Reflect.get(signature, 'type'), 'literal') ===
            'string'
            ? [String(Reflect.get(Reflect.get(signature, 'type'), 'literal'))]
            : [],
      ),
  )

// The declared Message tags no explored move ever sent. A tag missing here is
// either unreachable in this environment or never offered by it.
export const neverSent = <Model, Message, Input>(
  graph: Graph<Model, Message, Input>,
  tags: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const sent = new Set(Array.map(graph.edges, edge => edge.tag))
  return Array.filter(tags, tag => !sent.has(tag))
}
