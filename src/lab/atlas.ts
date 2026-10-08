import { Array, Option, Predicate, Schema, String, pipe } from 'effect'
import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineView } from 'foldkit/submodel'

import { type Choices, Decision, outcomes } from './fixture'
import { makeIdentity } from './identity'

// PROGRAM

export type Setup<Model, Message> = Readonly<{
  model: Model
  commands?: Update.Commands<Message>
  moves?: (model: Model) => Choices<Message>
  responders?: ReadonlyArray<Responder<Message>>
}>

// NOTE: `answer` is a method so a Responder built from a Command's typed args
// can join the list; the atlas only ever passes it that Command's own args.
export type Responder<Message> = Readonly<{
  command: string
  answer(args: Readonly<Record<string, unknown>>): Choices<Message>
}>

export const respond = <
  Args extends Readonly<Record<string, unknown>>,
  Message,
>(
  definition: Readonly<{ name: string }> & ((args: Args) => unknown),
  answer: (args: Args) => Choices<Message>,
): Responder<Message> => ({ command: definition.name, answer })

export type Program<Model, Message> = Readonly<{
  name: string
  Model: Schema.Codec<Model, unknown>
  Message: Schema.Codec<Message, unknown>
  update: (model: Model, message: Message) => Update.Return<Model, Message>
  view: (model: Model, h: HtmlBuilder<Message>) => Html
  cases: () => Choices<Setup<Model, Message>>
}>

// ADDRESS

export const Hop = Schema.Struct({
  kind: Schema.Literals(['Start', 'Move', 'Answer', 'Event']),
  decisions: Schema.Array(Decision),
  maybeMessage: Schema.Option(Schema.Unknown),
})
export type Hop = typeof Hop.Type

export const Address = Schema.Array(Hop)
export type Address = typeof Address.Type

const isSameHop = (left: Hop, right: Hop): boolean =>
  left.kind === right.kind &&
  left.decisions.length === right.decisions.length &&
  Array.every(left.decisions, (decision, index) => {
    const other = right.decisions[index]
    return (
      other !== undefined &&
      other.fixture === decision.fixture &&
      other.option === decision.option
    )
  })

// ATLAS

export type Step = Hop & Readonly<{ label: string; to: string }>

export type Reach = Readonly<{
  states: ReadonlyArray<string>
  isComplete: boolean
}>

export type PendingCommand = Readonly<{ name: string; args: string }>

export type FixtureOptions = Readonly<{
  name: string
  options: ReadonlyArray<string>
}>

export type Atlas = Readonly<{
  name: string
  reach: (depth: number) => Reach
  successors: (state: string) => ReadonlyArray<Step>
  send: (state: string, message: unknown) => Option.Option<string>
  trace: (state: string) => ReadonlyArray<Step>
  address: (state: string) => Address
  key: (state: string) => string
  resolve: (address: Address) => Option.Option<string>
  pending: (state: string) => ReadonlyArray<PendingCommand>
  encode: (state: string) => unknown
  fixtures: () => ReadonlyArray<FixtureOptions>
  render: <ParentMessage>(
    state: string,
    slot: string,
    h: HtmlBuilder<ParentMessage>,
    toParentMessage: (message: unknown) => ParentMessage,
  ) => Html
  nodes: () => number
}>

type Node<Model, Message> = Readonly<{
  id: string
  model: Model
  pending: Update.Commands<Message>
  setup: Setup<Model, Message>
  trace: ReadonlyArray<Step>
}>

type Arrival<Model, Message> = Hop &
  Readonly<{
    label: string
    maybeFrom: Option.Option<Node<Model, Message>>
    setup: Setup<Model, Message>
    model: Model
    pending: Update.Commands<Message>
  }>

const labelOf = (decisions: ReadonlyArray<Decision>) =>
  Array.join(
    Array.map(decisions, ({ option }) => option),
    ' ',
  )

const tagOf = (message: unknown): string =>
  Predicate.hasProperty(message, '_tag') && Predicate.isString(message._tag)
    ? message._tag
    : 'Message'

// NOTE: An atlas memoizes its Program's state graph as it is explored, so its
// caches only grow. Ids like S4 follow discovery order within one session;
// addresses name the same states across sessions.
export const make = <Model, Message>(
  program: Program<Model, Message>,
  budget = 5_000,
): Atlas => {
  const identity = makeIdentity()
  const nodes = new Map<string, Node<Model, Message>>()
  const idOf = new Map<unknown, string>()
  const successorsOf = new Map<string, ReadonlyArray<Step>>()
  const keyOf = new Map<string, string>()
  const layers: Array<ReadonlyArray<string>> = []
  const placed = new Set<string>()
  const fixtureOptions = new Map<string, ReadonlyArray<string>>()
  const isMessage = Schema.is(program.Message)
  const encodeMessage = Schema.encodeSync(program.Message)
  const decodeMessage = Schema.decodeUnknownOption(program.Message)
  const encodeAddress = Schema.encodeSync(Address)
  const encodeModel = Schema.encodeSync(program.Model)
  const view = defineView<Model, Message>(program.view)

  const nodeOf = (id: string): Node<Model, Message> =>
    pipe(
      Option.fromNullishOr(nodes.get(id)),
      Option.getOrThrowWith(() => new Error(`${program.name} has no ${id}.`)),
    )

  const learn = (decisions: ReadonlyArray<Decision>) =>
    Array.forEach(decisions, ({ fixture, option }) => {
      const options = fixtureOptions.get(fixture) ?? []
      if (!Array.contains(options, option)) {
        fixtureOptions.set(fixture, Array.append(options, option))
      }
    })

  const arrive = (arrival: Arrival<Model, Message>): Step => {
    const key = identity.of([
      arrival.setup.moves,
      arrival.setup.responders ?? [],
      arrival.model,
      Array.map(arrival.pending, command => [command.name, command.args ?? {}]),
    ])
    const stepTo = (to: string): Step => ({
      kind: arrival.kind,
      decisions: arrival.decisions,
      maybeMessage: arrival.maybeMessage,
      label: arrival.label,
      to,
    })
    const known = idOf.get(key)
    if (known !== undefined) {
      return stepTo(known)
    }
    const step = stepTo(`S${nodes.size + 1}`)
    idOf.set(key, step.to)
    nodes.set(step.to, {
      id: step.to,
      model: arrival.model,
      pending: arrival.pending,
      setup: arrival.setup,
      trace: Array.append(
        Option.match(arrival.maybeFrom, {
          onNone: () => [],
          onSome: from => from.trace,
        }),
        step,
      ),
    })
    learn(arrival.decisions)
    return step
  }

  const after = (
    node: Node<Model, Message>,
    message: Message,
    remaining: Update.Commands<Message>,
  ) => {
    const updated = program.update(node.model, message)
    return {
      maybeFrom: Option.some(node),
      setup: node.setup,
      model: updated.model,
      pending: Array.appendAll(remaining, updated.commands ?? []),
    }
  }

  const moves = (node: Node<Model, Message>): ReadonlyArray<Step> =>
    Option.match(Option.fromNullishOr(node.setup.moves), {
      onNone: () => [],
      onSome: choose =>
        Array.map(
          outcomes(() => choose(node.model)),
          ({ decisions, value }) =>
            arrive({
              kind: 'Move',
              decisions,
              maybeMessage: Option.none(),
              label: labelOf(decisions),
              ...after(node, value, node.pending),
            }),
        ),
    })

  const answers = (node: Node<Model, Message>): ReadonlyArray<Step> =>
    Option.match(Array.head(node.pending), {
      onNone: () => [],
      onSome: command =>
        pipe(
          Array.findFirst(
            node.setup.responders ?? [],
            responder => responder.command === command.name,
          ),
          Option.getOrThrowWith(
            () =>
              new Error(
                `${program.name} needs respond(${command.name}, …) in its cases.`,
              ),
          ),
          responder => outcomes(() => responder.answer(command.args ?? {})),
          Array.map(({ decisions, value }) =>
            arrive({
              kind: 'Answer',
              decisions,
              maybeMessage: Option.none(),
              label: Array.join(
                Array.filter(
                  [command.name, labelOf(decisions)],
                  String.isNonEmpty,
                ),
                ' ',
              ),
              ...after(node, value, Array.drop(node.pending, 1)),
            }),
          ),
        ),
    })

  const successors = (id: string): ReadonlyArray<Step> => {
    const known = successorsOf.get(id)
    if (known !== undefined) {
      return known
    }
    const node = nodeOf(id)
    const steps = [...moves(node), ...answers(node)]
    successorsOf.set(id, steps)
    return steps
  }

  const starts = (): ReadonlyArray<string> =>
    Array.map(
      outcomes(program.cases),
      ({ decisions, value }) =>
        arrive({
          kind: 'Start',
          decisions,
          maybeMessage: Option.none(),
          label: Array.isReadonlyArrayEmpty(decisions)
            ? 'start'
            : labelOf(decisions),
          maybeFrom: Option.none(),
          setup: value,
          model: value.model,
          pending: value.commands ?? [],
        }).to,
    )

  const place = (ids: ReadonlyArray<string>): ReadonlyArray<string> => {
    const fresh = Array.filter(Array.dedupe(ids), id => !placed.has(id))
    Array.forEach(fresh, id => placed.add(id))
    return fresh
  }

  const layerAt = (depth: number): ReadonlyArray<string> => {
    const known = layers[depth]
    if (known !== undefined) {
      return known
    }
    const layer =
      depth === 0
        ? place(starts())
        : placed.size >= budget
          ? []
          : place(
              Array.flatMap(layerAt(depth - 1), id =>
                Array.map(successors(id), step => step.to),
              ),
            )
    layers[depth] = layer
    return layer
  }

  const reach = (depth: number): Reach => ({
    states: Array.flatMap(Array.range(0, depth), layerAt),
    isComplete:
      Array.isReadonlyArrayEmpty(layerAt(depth + 1)) && placed.size < budget,
  })

  const send = (id: string, message: unknown): Option.Option<string> => {
    if (!isMessage(message)) {
      return Option.none()
    }
    const node = nodeOf(id)
    return Option.some(
      arrive({
        kind: 'Event',
        decisions: [],
        maybeMessage: Option.some(encodeMessage(message)),
        label: tagOf(message),
        ...after(node, message, node.pending),
      }).to,
    )
  }

  const address = (id: string): Address =>
    Array.map(nodeOf(id).trace, ({ kind, decisions, maybeMessage }) => ({
      kind,
      decisions,
      maybeMessage,
    }))

  const key = (id: string): string => {
    const known = keyOf.get(id)
    if (known !== undefined) {
      return known
    }
    const encoded = JSON.stringify(encodeAddress(address(id)))
    keyOf.set(id, encoded)
    return encoded
  }

  const follow = (id: string, hop: Hop): Option.Option<string> =>
    Option.match(hop.maybeMessage, {
      onNone: () =>
        Option.map(
          Array.findFirst(successors(id), step => isSameHop(step, hop)),
          step => step.to,
        ),
      onSome: encoded =>
        Option.flatMap(decodeMessage(encoded), message => send(id, message)),
    })

  const resolve = (address: Address): Option.Option<string> =>
    Array.match(address, {
      onEmpty: () => Option.none(),
      onNonEmpty: ([start, ...hops]) =>
        Array.reduce(
          hops,
          Array.findFirst(layerAt(0), id =>
            Option.exists(Array.head(nodeOf(id).trace), step =>
              isSameHop(step, start),
            ),
          ),
          (maybeId, hop) => Option.flatMap(maybeId, id => follow(id, hop)),
        ),
    })

  return {
    name: program.name,
    reach,
    successors,
    send,
    trace: id => nodeOf(id).trace,
    address,
    key,
    resolve,
    pending: id =>
      Array.map(nodeOf(id).pending, command => ({
        name: command.name,
        args: JSON.stringify(command.args ?? {}),
      })),
    encode: id => encodeModel(nodeOf(id).model),
    fixtures: () =>
      Array.map(Array.fromIterable(fixtureOptions), ([name, options]) => ({
        name,
        options,
      })),
    render: (id, slot, h, toParentMessage) =>
      h.submodel({
        slotId: slot,
        model: nodeOf(id).model,
        view,
        toParentMessage,
      }),
    nodes: identity.size,
  }
}

// DESCRIBE

export const describe = (atlas: Atlas, depth: number): string => {
  const { states, isComplete } = atlas.reach(depth)
  const stateView = (id: string) => [
    '',
    `${id}  ${Array.join(
      Array.map(atlas.trace(id), step => step.label),
      ' › ',
    )}`,
    `    ${JSON.stringify(atlas.encode(id))}`,
    ...Array.map(
      atlas.pending(id),
      ({ name, args }) => `    pending ${name} ${args}`,
    ),
    `    ${Array.join(
      Array.map(atlas.successors(id), step => `${step.label} → ${step.to}`),
      ' · ',
    )}`,
  ]
  return Array.join(
    [
      `# ${atlas.name} · depth ${depth} · ${states.length} states · ${isComplete ? 'complete' : 'incomplete'}`,
      ...Array.flatMap(states, stateView),
      '',
    ],
    '\n',
  )
}
