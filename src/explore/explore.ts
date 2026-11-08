import { Array } from 'effect'
import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Choices, outcomes } from './choices'
import { keyOf } from './key'

// PROGRAM

export type Program<Model, Message, Input = void> = Readonly<{
  name: string
  start: (input: Input) => Update.Return<Model, Message>
  update: (model: Model, message: Message) => Update.Return<Model, Message>
  view: (model: Model, h: HtmlBuilder<Message>) => Html
}>

// ENVIRONMENT

export type State<Model, Message, Input = void> = Readonly<{
  model: Model
  pending: Update.Commands<Message>
  input: Input
}>

type Request<Command extends RequestCommand = RequestCommand> = Readonly<{
  index: number
  command: Command
}>

type RequestCommand = Readonly<{
  name: string
  args?: Readonly<Record<string, unknown>>
}>

export type Move<Message> =
  | Readonly<{ kind: 'send'; message: Message }>
  | Readonly<{ kind: 'answer'; request: Request; message: Message }>

// A user event, or anything else that arrives. Pending Commands stay pending.
export const send = <Message>(message: Message): Move<Message> => ({
  kind: 'send',
  message,
})

// The reply to one pending Command. Only that occurrence is consumed.
export const answer = <Message>(
  request: Request,
  message: Message,
): Move<Message> => ({ kind: 'answer', request, message })

// NOTE: Foldkit identifies Commands by name, so a program's Command names must
// be unique. Matching by name recovers the Command's typed arguments.
export const pendingRequests = <Command extends RequestCommand>(
  state: Readonly<{ pending: ReadonlyArray<RequestCommand> }>,
  definition: Readonly<{ name: string }> & ((...args: never[]) => Command),
): Readonly<Record<string, Request<Command>>> => {
  const isMatch = (command: RequestCommand): command is Command =>
    command.name === definition.name
  return Object.fromEntries(
    Array.flatMap(state.pending, (command, index) =>
      isMatch(command) ? [[`${index}`, { index, command }]] : [],
    ),
  )
}

export type Environment<Model, Message, Input = void> = Readonly<{
  // Starting inputs, one per path through the fixtures.
  starts: () => Choices<Input>
  // What can happen next from a state, one Move per path through the fixtures.
  next?: (state: State<Model, Message, Input>) => Choices<Move<Message>>
  // States to drop. They are not stored and nothing is explored through them.
  prune?: (state: State<Model, Message, Input>) => boolean
  // States to explore but not show.
  show?: (state: State<Model, Message, Input>) => boolean
  // States with equal keys merge. Defaults to the input, Model and pending
  // Commands. Return less to merge more.
  key?: (state: State<Model, Message, Input>) => unknown
}>

// GRAPH

export type Node<Model, Message, Input = void> = State<Model, Message, Input> &
  Readonly<{
    id: number
    key: string
    depth: number
    // The fixture options that led here from its first-found parent.
    via: ReadonlyArray<string>
    shown: boolean
  }>

export type Edge = Readonly<{
  from: number
  to: number
  via: ReadonlyArray<string>
}>

export type Limits = Readonly<{
  depth: number
  states: number
  // Keys to drop, as if the environment pruned them.
  exclude?: ReadonlySet<string>
}>

export type Graph<Model, Message, Input = void> = Readonly<{
  nodes: ReadonlyArray<Node<Model, Message, Input>>
  edges: ReadonlyArray<Edge>
  // False when depth or states cut the search short.
  isComplete: boolean
}>

const issued = <Message>(
  result: Update.Return<unknown, Message>,
): Update.Commands<Message> => result.commands ?? []

// NOTE: Commands never execute. An answer removes its Command from the queue
// and then runs the real update.
const apply = <Model, Message, Input>(
  program: Program<Model, Message, Input>,
  state: State<Model, Message, Input>,
  move: Move<Message>,
): State<Model, Message, Input> => {
  const waiting =
    move.kind === 'send'
      ? state.pending
      : Array.filter(state.pending, (_, index) => index !== move.request.index)
  if (
    move.kind === 'answer' &&
    state.pending[move.request.index] !== move.request.command
  ) {
    throw new Error(
      `Answered a Command that is not pending: ${move.request.command.name}.`,
    )
  }
  const result = program.update(state.model, move.message)
  return {
    model: result.model,
    pending: Array.appendAll(waiting, issued(result)),
    input: state.input,
  }
}

export const explore = <Model, Message, Input>(
  program: Program<Model, Message, Input>,
  environment: Environment<Model, Message, Input>,
  limits: Limits,
): Graph<Model, Message, Input> => {
  const nodes: Array<Node<Model, Message, Input>> = []
  const edges: Array<Edge> = []
  const ids = new Map<string, number>()
  const status = { isComplete: true }

  const reach = (
    next: State<Model, Message, Input>,
    from: Node<Model, Message, Input> | undefined,
    via: ReadonlyArray<string>,
  ): void => {
    if (environment.prune?.(next)) {
      return
    }
    const key = keyOf(
      environment.key?.(next) ?? [
        next.input,
        next.model,
        Array.map(next.pending, command => [command.name, command.args ?? {}]),
      ],
    )
    if (limits.exclude?.has(key)) {
      return
    }
    const known = ids.get(key)
    const id = known ?? nodes.length
    if (known === undefined) {
      if (nodes.length >= limits.states) {
        status.isComplete = false
        return
      }
      ids.set(key, id)
      nodes.push({
        ...next,
        id,
        key,
        depth: from === undefined ? 0 : from.depth + 1,
        via,
        shown: environment.show?.(next) ?? true,
      })
    }
    if (from !== undefined) {
      edges.push({ from: from.id, to: id, via })
    }
  }

  for (const { path, value: input } of outcomes(environment.starts)) {
    const started = program.start(input)
    reach(
      { model: started.model, pending: issued(started), input },
      undefined,
      path,
    )
  }

  const next = environment.next
  // NOTE: Nodes appended during the loop are visited in turn: breadth first.
  for (const node of nodes) {
    if (next === undefined) {
      break
    }
    const moves = outcomes(() => next(node))
    if (node.depth >= limits.depth) {
      status.isComplete &&= moves.next().done === true
      continue
    }
    for (const { path, value: move } of moves) {
      reach(apply(program, node, move), node, path)
    }
  }
  return { nodes, edges, isComplete: status.isComplete }
}
