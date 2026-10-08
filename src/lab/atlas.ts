import { Array, Option, Predicate, Schema, String, pipe } from 'effect'
import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineView } from 'foldkit/submodel'

import { type Choices, Decision, outcomes } from './fixture'
import { makeIdentity } from './identity'
import { type InputDomain, inspect } from './interactions'

// PROGRAM

export type Setup<Model, Message> = Readonly<{
  model: Model
  commands?: Update.Commands<Message>
  moves?: (model: Model) => Choices<Message>
  responders?: ReadonlyArray<Responder<Message>>
  inputs?: ReadonlyArray<InputDomain>
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

export type State<Model, Message> = Readonly<{
  model: Model
  pending: Update.Commands<Message>
}>

export type Property<Model, Message> = Readonly<{
  name: string
  state?: (state: State<Model, Message>) => boolean
  transition?: (
    before: State<Model, Message>,
    message: Message,
    after: State<Model, Message>,
  ) => boolean
}>

export type Schedule = 'oldest' | 'any'

// NOTE: Every search stops at the same depth (trace length) and budget; they
// differ in which states they reach first and, past the budget, at all.
export const Search = Schema.Literals(['breadth', 'depth', 'random'])
export type Search = typeof Search.Type

export type Program<Model, Message> = Readonly<{
  name: string
  schedule?: Schedule
  properties?: ReadonlyArray<Property<Model, Message>>
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

export type Violation = Readonly<{
  property: string
  trace: ReadonlyArray<Step>
  state: string
}>
export type Group = Readonly<{ home: string; states: ReadonlyArray<string> }>

export type Atlas = Readonly<{
  name: string
  schedule: Schedule
  budget: number
  propertyNames: ReadonlyArray<string>
  check: (depth: number) => ReadonlyArray<Violation>
  groups: (states: ReadonlyArray<string>) => ReadonlyArray<Group>
  grouping: string
  reach: (depth: number, search?: Search) => Reach
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

const WALKS = 32

// NOTE: mulberry32, a small seeded generator, so random walks repeat exactly.
const random = (seed: number) => {
  let state = seed
  return (): number => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

// NOTE: An atlas memoizes its Program's state graph as it is explored, so its
// caches only grow. Ids like S4 follow discovery order within one session;
// addresses name the same states across sessions.
export const make = <Model, Message>(
  program: Program<Model, Message>,
  budget = 5_000,
): Atlas => {
  const schedule = program.schedule ?? 'oldest'
  const identity = makeIdentity()
  const inspections = new Map<
    unknown,
    ReturnType<typeof inspect<Model, Message>>
  >()
  const messages = new WeakMap<Step, Message>()
  const inspection = (node: Node<Model, Message>) => {
    const key = identity.of([node.model, node.setup.inputs])
    const known = inspections.get(key)
    if (known !== undefined) {
      return known
    }
    const result = inspect(program.view, node.model, node.setup.inputs ?? [])
    inspections.set(key, result)
    return result
  }
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
    if (
      arrival.setup.moves !== undefined &&
      arrival.setup.inputs !== undefined
    ) {
      throw new Error(
        `${program.name}: choose view-driven inputs or declared moves, not both.`,
      )
    }
    const key = identity.of([
      arrival.setup.moves,
      arrival.setup.inputs,
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

  const transition = (
    node: Node<Model, Message>,
    message: Message,
    remaining: Update.Commands<Message>,
    hop: Hop & Readonly<{ label: string }>,
  ): Step => {
    const step = arrive({ ...hop, ...after(node, message, remaining) })
    messages.set(step, message)
    return step
  }

  const moves = (node: Node<Model, Message>): ReadonlyArray<Step> =>
    node.setup.inputs !== undefined
      ? Array.map(inspection(node).interactions, ({ label, message }, index) =>
          transition(node, message, node.pending, {
            kind: 'Move',
            decisions: [
              { fixture: 'interaction', option: `${index}: ${label}` },
            ],
            maybeMessage: Option.none(),
            label,
          }),
        )
      : Option.match(Option.fromNullishOr(node.setup.moves), {
          onNone: () => [],
          onSome: choose =>
            Array.map(
              outcomes(() => choose(node.model)),
              ({ decisions, value }) =>
                transition(node, value, node.pending, {
                  kind: 'Move',
                  decisions,
                  maybeMessage: Option.none(),
                  label: labelOf(decisions),
                }),
            ),
        })

  const answers = (node: Node<Model, Message>): ReadonlyArray<Step> =>
    Array.flatMap(
      schedule === 'oldest' ? Array.take(node.pending, 1) : node.pending,
      (command, index) =>
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
            transition(
              node,
              value,
              Array.filter(
                node.pending,
                (_command, position) => position !== index,
              ),
              {
                kind: 'Answer',
                decisions:
                  schedule === 'any'
                    ? [{ fixture: 'pending', option: `${index}` }, ...decisions]
                    : decisions,
                maybeMessage: Option.none(),
                label: Array.join(
                  Array.filter(
                    [
                      command.name,
                      schedule === 'any' ? `#${index + 1}` : '',
                      labelOf(decisions),
                    ],
                    String.isNonEmpty,
                  ),
                  ' ',
                ),
              },
            ),
          ),
        ),
    )

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

  const breadthFirst = (depth: number): Reach => ({
    states: Array.flatMap(Array.range(0, depth), layerAt),
    isComplete:
      Array.isReadonlyArrayEmpty(layerAt(depth + 1)) && placed.size < budget,
  })

  // NOTE: A state found again on a shorter path is revisited, so depth-first
  // reaches the same states as breadth-first at the same depth unless the
  // budget runs out first.
  const depthFirst = (depth: number): ReadonlyArray<string> => {
    const shallowest = new Map<string, number>()
    const order: Array<string> = []
    const visit = (id: string, distance: number): void => {
      const known = shallowest.get(id)
      if (known !== undefined && known <= distance) {
        return
      }
      if (known === undefined) {
        if (order.length >= budget) {
          return
        }
        order.push(id)
      }
      shallowest.set(id, distance)
      if (distance < depth) {
        Array.forEach(successors(id), step => visit(step.to, distance + 1))
      }
    }
    Array.forEach(layerAt(0), id => visit(id, 0))
    return order
  }

  // NOTE: Each walk has its own seed, so a deeper search extends the same
  // walks instead of drawing new ones.
  const randomWalks = (depth: number): ReadonlyArray<string> =>
    Array.dedupe(
      Array.flatMap(Array.range(1, WALKS), seed => {
        const next = random(seed)
        const pick = <A>(items: ReadonlyArray<A>): Option.Option<A> =>
          Array.get(items, Math.floor(next() * items.length))
        const walk: Array<string> = []
        let maybeAt = pick(layerAt(0))
        while (Option.isSome(maybeAt) && walk.length <= depth) {
          walk.push(maybeAt.value)
          maybeAt = Option.map(pick(successors(maybeAt.value)), step => step.to)
        }
        return walk
      }),
    )

  const reaches = new Map<string, Reach>()
  const reach = (depth: number, search: Search = 'breadth'): Reach => {
    if (search === 'breadth') {
      return breadthFirst(depth)
    }
    const cacheKey = `${search} ${depth}`
    const known = reaches.get(cacheKey)
    if (known !== undefined) {
      return known
    }
    const states = Array.take(
      search === 'depth' ? depthFirst(depth) : randomWalks(depth),
      budget,
    )
    const reached = new Set(states)
    const result = {
      states,
      isComplete:
        reached.size < budget &&
        Array.every(states, id =>
          Array.every(successors(id), step => reached.has(step.to)),
        ),
    }
    reaches.set(cacheKey, result)
    return result
  }

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

  const checks = new Map<number, ReadonlyArray<Violation>>()
  const check = (depth: number): ReadonlyArray<Violation> => {
    const cached = checks.get(depth)
    if (cached !== undefined) {
      return cached
    }
    const failures = new Map<string, Violation>()
    const report = (failure: Violation) => {
      const previous = failures.get(failure.property)
      if (
        previous === undefined ||
        failure.trace.length < previous.trace.length
      ) {
        failures.set(failure.property, failure)
      }
    }
    const paths = new Map<string, ReadonlyArray<Step>>()
    Array.forEach(layerAt(0), id =>
      paths.set(id, Array.take(nodeOf(id).trace, 1)),
    )
    Array.forEach(Array.range(0, depth), distance => {
      Array.forEach(layerAt(distance), id => {
        const node = nodeOf(id)
        const trace = paths.get(id) ?? []
        Array.forEach(program.properties ?? [], property => {
          if (property.state !== undefined && !property.state(node)) {
            report({ property: property.name, trace, state: id })
          }
        })
        if (distance < depth) {
          Array.forEach(successors(id), step => {
            const nextTrace = Array.append(trace, step)
            if (!paths.has(step.to)) {
              paths.set(step.to, nextTrace)
            }
            const message = messages.get(step)
            if (message !== undefined) {
              Array.forEach(program.properties ?? [], property => {
                if (
                  property.transition !== undefined &&
                  !property.transition(node, message, nodeOf(step.to))
                ) {
                  report({
                    property: property.name,
                    trace: nextTrace,
                    state: step.to,
                  })
                }
              })
            }
          })
        }
      })
    })
    const result = Array.fromIterable(failures.values())
    checks.set(depth, result)
    return result
  }

  const groups = (states: ReadonlyArray<string>): ReadonlyArray<Group> => {
    const grouped = new Map<unknown, { home: string; states: Array<string> }>()
    Array.forEach(states, id => {
      const node = nodeOf(id)
      const key =
        node.setup.inputs === undefined
          ? identity.of(node.model)
          : inspection(node).screen
      const known = grouped.get(key)
      if (known !== undefined) {
        known.states.push(id)
      } else {
        grouped.set(key, { home: id, states: [id] })
      }
    })
    return Array.fromIterable(grouped.values())
  }

  return {
    name: program.name,
    schedule,
    budget,
    propertyNames: Array.map(
      program.properties ?? [],
      property => property.name,
    ),
    check,
    groups,
    grouping: 'Rendered markup for view-driven cases; equal Models otherwise',
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
    ...Array.match(atlas.successors(id), {
      onEmpty: () => [],
      onNonEmpty: steps => [
        `    ${Array.join(
          Array.map(steps, step => `${step.label} → ${step.to}`),
          ' · ',
        )}`,
      ],
    }),
  ]
  return Array.join(
    [
      `# ${atlas.name} · depth ${depth} · ${states.length} states · ${isComplete ? 'complete' : 'incomplete'}`,
      `# Replies: ${atlas.schedule}; independent response fixtures; exploration threshold: ${atlas.budget} states`,
      ...Array.flatMap(states, stateView),
      '',
    ],
    '\n',
  )
}
