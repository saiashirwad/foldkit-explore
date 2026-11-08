import { Array, Predicate } from 'effect'

import { pathTo, tagOf } from './check'
import type { Edge, Graph } from './explore'

// JSON with plain property names. Run it through the formatter.
const literal = (value: unknown): string =>
  (JSON.stringify(value, null, 2) ?? 'undefined').replaceAll(
    /^(\s*)"([A-Za-z_]\w*)":/gm,
    '$1$2:',
  )

// `Message.Tag({ ...fields })`, as written by hand.
const messageOf = (message: unknown): string => {
  const tag = tagOf(message)
  if (tag === undefined || !Predicate.isObject(message)) {
    return literal(message)
  }
  const fields = Object.fromEntries(
    Object.entries(message).filter(([name]) => name !== '_tag'),
  )
  return `Message.${tag}(${Object.keys(fields).length === 0 ? '' : literal(fields)})`
}

// The edge that first reached each state on the way from a start to `id`.
const routeTo = <Model, Message, Input>(
  graph: Graph<Model, Message, Input>,
  id: number,
): ReadonlyArray<Edge> => {
  const edges: Array<Edge> = []
  for (
    let node = graph.nodes[id];
    node?.parent !== undefined;
    node = graph.nodes[node.parent]
  ) {
    const { parent, id: to } = node
    const edge = graph.edges.find(
      candidate => candidate.from === parent && candidate.to === to,
    )
    if (edge !== undefined) {
      edges.unshift(edge)
    }
  }
  return edges
}

// A Foldkit `story` test that starts where the explorer started, makes each
// move on the way, and checks the Model it ends in. Commands still pending
// at the end are listed, because a story fails while any are unresolved.
export const storyOf = <Model, Message, Input>(
  graph: Graph<Model, Message, Input>,
  id: number,
): string | undefined => {
  const target = graph.nodes[id]
  const edges = routeTo(graph, id)
  const root = graph.nodes[edges[0]?.from ?? id]
  if (target === undefined || root === undefined) {
    return undefined
  }
  const steps = Array.map(edges, ({ move }) =>
    move.kind === 'send'
      ? `message(${messageOf(move.message)})`
      : `Command.resolve(${move.request.command.name}, ${messageOf(move.message)})`,
  )
  const pending = Array.map(target.pending, command => command.name)
  const commands = Array.dedupe([
    ...Array.flatMap(edges, ({ move }) =>
      move.kind === 'answer' ? [move.request.command.name] : [],
    ),
    ...pending,
  ])
  const lines = [
    `given(${literal(root.model)})`,
    ...steps,
    `model(model => {\n  expect(model).toEqual(${literal(target.model)})\n})`,
    ...(pending.length === 0
      ? []
      : [
          `Command.expectHas(${pending.join(', ')})`,
          '// TODO: resolve the pending Commands. A story fails while any remain.',
        ]),
  ]
  return [
    `import { Command, given, message, model, story } from 'foldkit/story'`,
    `import { expect, test } from 'vitest'`,
    '',
    '// Adjust this import to where the program lives.',
    `import { ${Array.join(['Message', 'update', ...commands], ', ')} } from './main'`,
    '',
    `test(${JSON.stringify(`reaches ${pathTo(graph, id).join(' › ')}`)}, () => {`,
    '  story(',
    '    update,',
    ...Array.map(lines, line => `    ${line.replaceAll('\n', '\n    ')},`),
    '  )',
    '})',
  ].join('\n')
}
