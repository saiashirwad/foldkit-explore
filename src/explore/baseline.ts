import { Array, Schema } from 'effect'

import { type Comparison, type Side, diff, sideOf } from './compare'
import { type Environment, type Limits, type Program, explore } from './explore'

// A small record of every explored state: what it shows and where it leads.
// Commit it, and a later run can be diffed against it without the old code.
export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  isComplete: Schema.Boolean,
  // The limits it was taken with, so a later run can repeat them.
  limits: Schema.Struct({ depth: Schema.Number, states: Schema.Number }),
  // Start states, by the choices that led to them, as indexes into `nodes`.
  roots: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
  nodes: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      // A hash of everything rendered, since the text can hide differences.
      hash: Schema.String,
      commands: Schema.String,
    }),
  ),
  // From, to, and the choices that made the move.
  edges: Schema.Array(
    Schema.Tuple([Schema.Number, Schema.Number, Schema.String]),
  ),
})
export type Snapshot = typeof Snapshot.Type

// cyrb53: small, fast, and enough to notice a changed screen.
const hashOf = (text: string): string => {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (const code of Array.map([...text], char => char.charCodeAt(0))) {
    a = Math.imul(a ^ code, 2654435761)
    b = Math.imul(b ^ code, 1597334677)
  }
  a =
    Math.imul(a ^ (a >>> 16), 2246822507) ^
    Math.imul(b ^ (b >>> 13), 3266489909)
  b =
    Math.imul(b ^ (b >>> 16), 2246822507) ^
    Math.imul(a ^ (a >>> 13), 3266489909)
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16)
}

export const snapshotOf = <Model, Message, Input>(
  program: Program<Model, Message, Input>,
  environment: Environment<Model, Message, Input>,
  limits: Limits,
): Snapshot => {
  const graph = explore(program, environment, limits)
  const side = sideOf(program, graph)
  return {
    version: 1,
    name: program.name,
    isComplete: graph.isComplete,
    limits: { depth: limits.depth, states: limits.states },
    roots: [...side.roots],
    nodes: Array.map(graph.nodes, node => ({
      text: side.screen(node.id).text,
      hash: hashOf(side.screen(node.id).key),
      commands: side.commands(node.id),
    })),
    edges: Array.map(graph.edges, edge => [
      edge.from,
      edge.to,
      edge.via.join(' · '),
    ]),
  }
}

const sideOfSnapshot = (snapshot: Snapshot): Side<unknown> => {
  const out = new Map<number, Map<string, number>>()
  for (const [from, to, via] of snapshot.edges) {
    out.set(from, (out.get(from) ?? new Map()).set(via, to))
  }
  return {
    roots: new Map(snapshot.roots),
    out,
    screen: id => ({
      text: snapshot.nodes[id]?.text ?? '',
      key: snapshot.nodes[id]?.hash ?? '',
    }),
    commands: id => snapshot.nodes[id]?.commands ?? '',
    model: () => undefined,
    isComplete: snapshot.isComplete,
  }
}

// What changed since the baseline. Findings have no states to preview.
export const diffSnapshots = (
  baseline: Snapshot,
  current: Snapshot,
): Comparison => diff(sideOfSnapshot(baseline), sideOfSnapshot(current))

// One state or move per line, so a review diff shows what changed.
export const encodeSnapshot = (snapshot: Snapshot): string => {
  const rows = (items: ReadonlyArray<unknown>): string =>
    `[\n${Array.map(items, item => JSON.stringify(item)).join(',\n')}\n]`
  return `${[
    '{',
    `"version": ${snapshot.version},`,
    `"name": ${JSON.stringify(snapshot.name)},`,
    `"isComplete": ${snapshot.isComplete},`,
    `"limits": ${JSON.stringify(snapshot.limits)},`,
    `"roots": ${JSON.stringify(snapshot.roots)},`,
    `"nodes": ${rows(snapshot.nodes)},`,
    `"edges": ${rows(snapshot.edges)}`,
    '}',
  ].join('\n')}\n`
}

export const decodeSnapshot = (text: string): Snapshot =>
  Schema.decodeUnknownSync(Snapshot)(JSON.parse(text))

// The findings as lines for a person to read, or '' when there are none.
export const formatFindings = (comparison: Comparison): string =>
  Array.map(comparison.findings, finding => {
    const head = `${finding.kind} ×${finding.count} at ${finding.path.join(' › ')}`
    return finding.kind === 'only-before' || finding.kind === 'only-after'
      ? `${head}: ${finding.before ?? finding.after}`
      : `${head}\n  was: ${finding.before}\n  now: ${finding.after}`
  }).join('\n')
