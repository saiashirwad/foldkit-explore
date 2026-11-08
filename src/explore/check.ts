import { Array } from 'effect'

import type { Graph, State } from './explore'

export type Violation = Readonly<{
  id: number
  // The choices made at each step, from a start to the state.
  path: ReadonlyArray<string>
}>

const pathTo = <Model, Message, Input>(
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
