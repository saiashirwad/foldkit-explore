import { Array, Option, Predicate, Schema, pipe } from 'effect'
import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineView } from 'foldkit/submodel'

import { canonical } from './canonical'
import { type Choices, Decision, type Outcome, outcomes } from './fixture'
import { makeIdentity } from './identity'
import { type InputDomain, inspect } from './interactions'
import { type Observation, describeCommands } from './observation'

// PROGRAM

export type State<Model, Message> = Readonly<{
  model: Model
  pending: Update.Commands<Message>
}>

export type NextState<Model, Message, Input = unknown> = State<Model, Message> &
  Readonly<{
    input: Input
    interactions: Readonly<Record<string, Message>>
  }>

export type Program<Model, Message, Input = void> = Readonly<{
  name: string
  Model: Schema.Codec<Model, unknown>
  Message: Schema.Codec<Message, unknown>
  start: (input: Input) => Update.Return<Model, Message>
  update: (model: Model, message: Message) => Update.Return<Model, Message>
  view: (model: Model, h: HtmlBuilder<Message>) => Html
}>

export type Environment<Model, Message, Input = void> = Readonly<{
  starts: () => Choices<Input>
  inputs?: ReadonlyArray<InputDomain>
  next?: (
    state: NextState<Model, Message, Input>,
  ) => Choices<Transition<Message>>
}>

type RequestCommand = Readonly<{
  name: string
  args?: Readonly<Record<string, unknown>>
}>

export type Request<C extends RequestCommand = RequestCommand> = Readonly<{
  index: number
  command: C
}>

export type Transition<Message> =
  | Readonly<{ kind: 'Move'; message: Message }>
  | Readonly<{ kind: 'Answer'; request: Request; message: Message }>

export const send = <Message>(message: Message): Transition<Message> => ({
  kind: 'Move',
  message,
})

export const answer = <Message>(
  request: Request,
  message: Message,
): Transition<Message> => ({ kind: 'Answer', request, message })

// NOTE: Foldkit identifies Commands by name. Definitions used in one program
// must have unique names; matching a definition recovers its typed arguments.
export const pendingRequests = <C extends RequestCommand>(
  state: Readonly<{ pending: ReadonlyArray<RequestCommand> }>,
  definition: Readonly<{ name: string }> & ((...args: never[]) => C),
): Readonly<Record<string, Request<C>>> => {
  const matches = (command: RequestCommand): command is C =>
    command.name === definition.name
  return Object.fromEntries(
    Array.flatMap(state.pending, (command, index) =>
      matches(command) ? [[`${index}`, { index, command }]] : [],
    ),
  )
}

export type Property<Model, Message> = Readonly<{
  name: string
  state?: (state: State<Model, Message>) => boolean
  transition?: (
    before: State<Model, Message>,
    message: Message,
    after: State<Model, Message>,
  ) => boolean
}>

export const Search = Schema.Literals(['breadth', 'depth', 'random'])
export type Search = typeof Search.Type

export type Limits = Readonly<{ states?: number; transitions?: number }>
export type ExplorationLimits = Readonly<{
  states: number
  transitions: number
}>
export type Options<Model, Message> = Readonly<{
  properties?: ReadonlyArray<Property<Model, Message>>
  limits?: Limits
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
export type ReachStatus =
  | 'complete'
  | 'depth-limit'
  | 'state-limit'
  | 'transition-limit'
export type SuccessorStatus = 'unseen' | 'partial' | 'complete'

export type Reach = Readonly<{
  states: ReadonlyArray<string>
  status: ReachStatus
  counters: Readonly<{ states: number; transitions: number; starts: number }>
  unfinishedWork: Readonly<{
    starts: boolean
    states: number
    transitions: number
  }>
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
  limits: ExplorationLimits
  propertyNames: ReadonlyArray<string>
  check: (depth: number, limits?: Limits) => ReadonlyArray<Violation>
  groups: (states: ReadonlyArray<string>) => ReadonlyArray<Group>
  grouping: string
  reach: (depth: number, search?: Search, limits?: Limits) => Reach
  successors: (state: string, limits?: Limits) => ReadonlyArray<Step>
  knownSuccessors: (state: string) => ReadonlyArray<Step>
  successorStatus: (state: string) => SuccessorStatus
  interact: (state: string, message: unknown) => Option.Option<string>
  observe: (state: string) => Observation
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

type Node<Model, Message, Input> = State<Model, Message> &
  Readonly<{
    id: string
    input: Input
    trace: ReadonlyArray<Step>
  }>

type Arrival<Model, Message, Input> = Hop &
  State<Model, Message> &
  Readonly<{
    label: string
    maybeFrom: Option.Option<Node<Model, Message, Input>>
    input: Input
    maybeMessageValue: Option.Option<Message>
  }>

type Source<Value> = {
  iterator: Iterator<Outcome<Value>>
  values: Array<Outcome<Value>>
  done: boolean
}

type Read<Value> =
  | Readonly<{ kind: 'value'; outcome: Outcome<Value> }>
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'limit' }>

type SearchResult = Readonly<{
  reach: Reach
  paths: ReadonlyMap<string, ReadonlyArray<Step>>
  edges: ReadonlyMap<string, ReadonlyArray<Step>>
}>

const source = <Value>(choices: () => Choices<Value>): Source<Value> => ({
  iterator: outcomes(choices),
  values: [],
  done: false,
})

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

// NOTE: mulberry32 gives each walk a repeatable seed.
const random = (seed: number) => {
  const state = { value: seed }
  return (): number => {
    state.value = (state.value + 0x6d2b79f5) | 0
    const first = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    const mixed = (first + Math.imul(first ^ (first >>> 7), 61 | first)) ^ first
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const limit = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`)
  }
  return value
}

// NOTE: Sources retain their iterator and every yielded alternative. A stop
// before admission therefore resumes the same alternative without replaying
// start or update. Transition work includes starts, even when states merge.
export const make = <Model, Message, Input = void>(
  program: Program<Model, Message, Input>,
  environment: Environment<Model, Message, Input>,
  options: Options<Model, Message> = {},
): Atlas => {
  const limits: ExplorationLimits = {
    states: limit(options.limits?.states ?? 5_000, 'State limit'),
    transitions: limit(
      options.limits?.transitions ?? 50_000,
      'Transition limit',
    ),
  }
  const identity = makeIdentity()
  const nodes = new Map<string, Node<Model, Message, Input>>()
  const idOf = new Map<unknown, string>()
  const arrivals = new WeakMap<object, Arrival<Model, Message, Input>>()
  const arrivalKeys = new WeakMap<object, unknown>()
  const steps = new WeakMap<object, Step>()
  const messages = new WeakMap<Step, Readonly<{ message: Message }>>()
  const sources = new Map<string, Source<Transition<Message>>>()
  const inspections = new Map<
    unknown,
    ReturnType<typeof inspect<Model, Message>>
  >()
  const startSource = source(environment.starts)
  const fixtureOptions = new Map<string, ReadonlyArray<string>>()
  const keyOf = new Map<string, string>()
  const revision = { value: 0 }
  const results = new Map<
    string,
    Readonly<{ revision: number; result: SearchResult }>
  >()
  const isMessage = Schema.is(program.Message)
  const encodeMessage = Schema.encodeSync(program.Message)
  const decodeMessage = Schema.decodeUnknownOption(program.Message)
  const encodeModel = Schema.encodeSync(program.Model)
  const encodeAddress = Schema.encodeSync(Address)
  const view = defineView<Model, Message>(program.view)

  const nodeOf = (id: string): Node<Model, Message, Input> =>
    pipe(
      Option.fromNullishOr(nodes.get(id)),
      Option.getOrThrowWith(() => new Error(`${program.name} has no ${id}.`)),
    )

  const inspection = (node: Node<Model, Message, Input>) => {
    const key = identity.of(node.model)
    const known = inspections.get(key)
    if (known !== undefined) {
      return known
    }
    const result = inspect(
      program.view,
      node.model,
      environment.inputs ?? [],
      encodeMessage,
    )
    inspections.set(key, result)
    return result
  }

  const learn = (decisions: ReadonlyArray<Decision>) =>
    Array.forEach(decisions, ({ fixture, option }) => {
      const known = fixtureOptions.get(fixture) ?? []
      if (!Array.contains(known, option)) {
        fixtureOptions.set(fixture, Array.append(known, option))
      }
    })

  const arrivalKey = (arrival: Arrival<Model, Message, Input>): unknown => {
    const known = arrivalKeys.get(arrival)
    if (known !== undefined) {
      return known
    }
    const key = identity.of([
      arrival.input,
      arrival.model,
      Array.map(arrival.pending, command => [command.name, command.args ?? {}]),
    ])
    arrivalKeys.set(arrival, key)
    return key
  }

  const arrive = (arrival: Arrival<Model, Message, Input>): Step => {
    const knownStep = steps.get(arrival)
    if (knownStep !== undefined) {
      return knownStep
    }
    const key = arrivalKey(arrival)
    const known = idOf.get(key)
    const step: Step = {
      kind: arrival.kind,
      decisions: arrival.decisions,
      maybeMessage: arrival.maybeMessage,
      label: arrival.label,
      to: known ?? `S${nodes.size + 1}`,
    }
    if (known === undefined) {
      idOf.set(key, step.to)
      nodes.set(step.to, {
        id: step.to,
        input: arrival.input,
        model: arrival.model,
        pending: arrival.pending,
        trace: Array.append(
          Option.match(arrival.maybeFrom, {
            onNone: () => [],
            onSome: from => from.trace,
          }),
          step,
        ),
      })
      revision.value += 1
    }
    steps.set(arrival, step)
    Option.match(arrival.maybeMessageValue, {
      onNone: () => undefined,
      onSome: message => messages.set(step, { message }),
    })
    learn(arrival.decisions)
    return step
  }

  const startArrival = (
    outcome: Outcome<Input>,
  ): Arrival<Model, Message, Input> => {
    const known = arrivals.get(outcome)
    if (known !== undefined) {
      return known
    }
    const started = program.start(outcome.value)
    const arrival: Arrival<Model, Message, Input> = {
      kind: 'Start',
      decisions: outcome.decisions,
      maybeMessage: Option.none(),
      label: Array.isReadonlyArrayEmpty(outcome.decisions)
        ? 'start'
        : labelOf(outcome.decisions),
      maybeFrom: Option.none(),
      input: outcome.value,
      model: started.model,
      pending: started.commands ?? [],
      maybeMessageValue: Option.none(),
    }
    arrivals.set(outcome, arrival)
    return arrival
  }

  const after = (
    node: Node<Model, Message, Input>,
    message: Message,
    remaining: Update.Commands<Message>,
  ) => {
    const updated = program.update(node.model, message)
    return {
      maybeFrom: Option.some(node),
      input: node.input,
      model: updated.model,
      pending: Array.appendAll(remaining, updated.commands ?? []),
      maybeMessageValue: Option.some(message),
    }
  }

  const nextArrival = (
    node: Node<Model, Message, Input>,
    outcome: Outcome<Transition<Message>>,
  ): Arrival<Model, Message, Input> => {
    const known = arrivals.get(outcome)
    if (known !== undefined) {
      return known
    }
    const { decisions, value } = outcome
    if (!isMessage(value.message)) {
      throw new Error(`${program.name}: next returned an invalid Message.`)
    }
    const hop = { decisions, maybeMessage: Option.none() }
    const interactions =
      environment.inputs === undefined ? [] : inspection(node).interactions
    const label = Array.join(
      Array.map(
        decisions,
        decision =>
          interactions.find(interaction => interaction.key === decision.option)
            ?.label ?? decision.option,
      ),
      ' ',
    )
    const create = (): Arrival<Model, Message, Input> => {
      if (value.kind === 'Move') {
        return {
          ...hop,
          kind: 'Move',
          label,
          ...after(node, value.message, node.pending),
        }
      }
      const { index, command } = value.request
      if (node.pending[index] !== command) {
        throw new Error(
          `${program.name}: answer must select a pending Command from this state.`,
        )
      }
      return {
        ...hop,
        kind: 'Answer',
        label: `${command.name} #${index + 1} ${label}`.trimEnd(),
        ...after(
          node,
          value.message,
          Array.filter(
            node.pending,
            (_command, position) => position !== index,
          ),
        ),
      }
    }
    const arrival = create()
    arrivals.set(outcome, arrival)
    return arrival
  }

  const sourceOf = (id: string): Source<Transition<Message>> => {
    const known = sources.get(id)
    if (known !== undefined) {
      return known
    }
    const node = nodeOf(id)
    const next = environment.next
    const current: Source<Transition<Message>> =
      next === undefined
        ? {
            iterator:
              Array.empty<Outcome<Transition<Message>>>()[Symbol.iterator](),
            values: [],
            done: true,
          }
        : source(() =>
            next({
              input: node.input,
              model: node.model,
              pending: node.pending,
              interactions:
                environment.inputs === undefined
                  ? {}
                  : Object.fromEntries(
                      Array.map(
                        inspection(node).interactions,
                        ({ key, message }) => [key, message],
                      ),
                    ),
            }),
          )
    sources.set(id, current)
    return current
  }

  const pull = <Value>(
    current: Source<Value>,
    index: number,
  ): Option.Option<Outcome<Value>> => {
    const known = current.values[index]
    if (known !== undefined) {
      return Option.some(known)
    }
    if (current.done) {
      return Option.none()
    }
    const item = current.iterator.next()
    revision.value += 1
    if (item.done) {
      current.done = true
      return Option.none()
    }
    current.values.push(item.value)
    return Option.some(item.value)
  }

  const knownSuccessors = (id: string): ReadonlyArray<Step> => {
    nodeOf(id)
    return Array.getSomes(
      Array.map(sources.get(id)?.values ?? [], outcome =>
        Option.flatMap(Option.fromNullishOr(arrivals.get(outcome)), arrival =>
          Option.fromNullishOr(steps.get(arrival)),
        ),
      ),
    )
  }

  const successors = (
    id: string,
    override: Limits = {},
  ): ReadonlyArray<Step> => {
    const node = nodeOf(id)
    const bound = {
      states: limit(override.states ?? limits.states, 'State limit'),
      transitions: limit(
        override.transitions ?? limits.transitions,
        'Transition limit',
      ),
    }
    const admitted = new Set([id])
    const result: Array<Step> = []
    if (bound.states === 0) {
      return result
    }
    const current = sourceOf(id)
    const cursor = { index: 0 }
    while (cursor.index < bound.transitions) {
      const maybeOutcome = pull(current, cursor.index)
      if (Option.isNone(maybeOutcome)) {
        return result
      }
      const arrival = nextArrival(node, maybeOutcome.value)
      const known = idOf.get(arrivalKey(arrival))
      if (
        (known === undefined || !admitted.has(known)) &&
        admitted.size >= bound.states
      ) {
        return result
      }
      const step = arrive(arrival)
      admitted.add(step.to)
      result.push(step)
      cursor.index += 1
    }
    return result
  }

  const run = (
    requestedDepth: number,
    search: Search = 'breadth',
    override: Limits = {},
  ): SearchResult => {
    const depth = limit(requestedDepth, 'Depth')
    const bound = {
      states: limit(override.states ?? limits.states, 'State limit'),
      transitions: limit(
        override.transitions ?? limits.transitions,
        'Transition limit',
      ),
    }
    const cacheKey = `${search} ${depth} ${bound.states} ${bound.transitions}`
    const known = results.get(cacheKey)
    if (known?.revision === revision.value) {
      return known.result
    }
    const order: Array<string> = []
    const distances = new Map<string, number>()
    const paths = new Map<string, ReadonlyArray<Step>>()
    const edges = new Map<string, Array<Step>>()
    const expanded = new Map<string, number>()
    const frontier = new Set<string>()
    const deferred = new Set<object>()
    const charged = new Set<object>()
    const counters = { states: 0, transitions: 0, starts: 0 }
    const progress: {
      stopped: 'state-limit' | 'transition-limit' | undefined
      startsDone: boolean
      startIndex: number
    } = {
      stopped: undefined,
      startsDone: false,
      startIndex: 0,
    }

    const read = <Value>(
      current: Source<Value>,
      index: number,
      isStart = false,
    ): Read<Value> => {
      const known = current.values[index]
      if (known === undefined && current.done) {
        return { kind: 'done' }
      }
      if (
        (known === undefined || !charged.has(known)) &&
        counters.transitions >= bound.transitions
      ) {
        progress.stopped = 'transition-limit'
        return { kind: 'limit' }
      }
      const maybeOutcome = pull(current, index)
      if (Option.isNone(maybeOutcome)) {
        return { kind: 'done' }
      }
      const outcome = maybeOutcome.value
      if (!charged.has(outcome)) {
        charged.add(outcome)
        counters.transitions += 1
        if (isStart) {
          counters.starts += 1
        }
      }
      return { kind: 'value', outcome }
    }

    const admit = (
      arrival: Arrival<Model, Message, Input>,
      distance: number,
    ): Option.Option<Step> => {
      const knownId = idOf.get(arrivalKey(arrival))
      const knownDistance =
        knownId === undefined ? undefined : distances.get(knownId)
      if (knownDistance === undefined && distance > depth) {
        deferred.add(arrival)
        return Option.none()
      }
      if (knownDistance === undefined && order.length >= bound.states) {
        deferred.add(arrival)
        progress.stopped = 'state-limit'
        return Option.none()
      }
      deferred.delete(arrival)
      const step = arrive(arrival)
      if (knownDistance === undefined) {
        order.push(step.to)
        counters.states += 1
      }
      if (knownDistance === undefined || distance < knownDistance) {
        distances.set(step.to, distance)
        const prefix = Option.match(arrival.maybeFrom, {
          onNone: () => [],
          onSome: from => paths.get(from.id) ?? [],
        })
        paths.set(step.to, Array.append(prefix, step))
      }
      return Option.some(step)
    }

    const record = (id: string, step: Step) => {
      const known = edges.get(id) ?? []
      if (!known.includes(step)) {
        known.push(step)
        edges.set(id, known)
      }
    }

    const startOutcomes: Array<Outcome<Input>> = []
    while (progress.stopped === undefined && !progress.startsDone) {
      const item = read(startSource, progress.startIndex, true)
      if (item.kind === 'done') {
        progress.startsDone = true
      } else if (item.kind === 'value') {
        startOutcomes.push(item.outcome)
        if (search !== 'random') {
          admit(startArrival(item.outcome), 0)
        }
        progress.startIndex += 1
      }
    }

    const expand = (
      id: string,
      distance: number,
      visit: (step: Step) => void,
    ) => {
      const current = sourceOf(id)
      const node = nodeOf(id)
      const cursor = { index: 0, done: false }
      frontier.add(id)
      while (progress.stopped === undefined && !cursor.done) {
        const item = read(current, cursor.index)
        if (item.kind === 'done') {
          expanded.set(id, distance)
          frontier.delete(id)
          cursor.done = true
        } else if (item.kind === 'value') {
          const maybeStep = admit(nextArrival(node, item.outcome), distance + 1)
          if (Option.isSome(maybeStep)) {
            record(id, maybeStep.value)
            visit(maybeStep.value)
          } else {
            cursor.done = true
          }
          cursor.index += 1
        }
      }
    }

    if (search === 'breadth') {
      const cursor = { index: 0 }
      while (progress.stopped === undefined && cursor.index < order.length) {
        const id = order[cursor.index]
        if (id !== undefined) {
          expand(id, distances.get(id) ?? 0, () => undefined)
        }
        cursor.index += 1
      }
    } else if (search === 'depth') {
      const frames: Array<{ id: string; distance: number; index: number }> = []
      const schedule = (id: string, distance: number) => {
        if ((expanded.get(id) ?? Infinity) > distance) {
          expanded.set(id, distance)
          frontier.add(id)
          frames.push({ id, distance, index: 0 })
        }
      }
      Array.forEach(Array.reverse(order), id =>
        frames.push({ id, distance: 0, index: 0 }),
      )
      while (progress.stopped === undefined && Array.isArrayNonEmpty(frames)) {
        const frame = frames.at(-1)
        if (frame === undefined) {
          break
        }
        frontier.add(frame.id)
        expanded.set(frame.id, frame.distance)
        const item = read(sourceOf(frame.id), frame.index)
        if (item.kind === 'done') {
          frontier.delete(frame.id)
          frames.pop()
        } else if (item.kind === 'value') {
          frame.index += 1
          const maybeStep = admit(
            nextArrival(nodeOf(frame.id), item.outcome),
            frame.distance + 1,
          )
          if (Option.isNone(maybeStep)) {
            frames.pop()
          } else {
            record(frame.id, maybeStep.value)
            if (frame.distance < depth) {
              schedule(maybeStep.value.to, frame.distance + 1)
            }
          }
        }
      }
    } else {
      const sampledStarts = new Set<object>()
      Array.forEach(Array.range(1, WALKS), seed => {
        if (progress.stopped !== undefined) {
          return
        }
        const next = random(seed)
        const starting =
          startOutcomes[Math.floor(next() * startOutcomes.length)]
        if (starting === undefined) {
          return
        }
        sampledStarts.add(starting)
        const walk = { at: admit(startArrival(starting), 0), distance: 0 }
        while (
          progress.stopped === undefined &&
          Option.isSome(walk.at) &&
          walk.distance < depth
        ) {
          const id = walk.at.value.to
          const current = sourceOf(id)
          const offered: Array<Outcome<Transition<Message>>> = []
          const cursor = { index: 0, done: false }
          frontier.add(id)
          while (progress.stopped === undefined && !cursor.done) {
            const item = read(current, cursor.index)
            if (item.kind === 'done') {
              cursor.done = true
            } else if (item.kind === 'value') {
              offered.push(item.outcome)
              cursor.index += 1
            }
          }
          if (progress.stopped !== undefined) {
            return
          }
          const selected = offered[Math.floor(next() * offered.length)]
          if (selected === undefined) {
            frontier.delete(id)
            expanded.set(id, walk.distance)
            walk.at = Option.none()
          } else {
            walk.at = admit(
              nextArrival(nodeOf(id), selected),
              walk.distance + 1,
            )
            if (Option.isSome(walk.at)) {
              record(id, walk.at.value)
            }
            walk.distance += 1
          }
        }
      })
      Array.forEach(order, id => {
        const current = sources.get(id)
        if (
          environment.next === undefined ||
          (current?.done &&
            current.values.every(outcome => {
              const arrival = arrivals.get(outcome)
              const step =
                arrival === undefined ? undefined : steps.get(arrival)
              return step !== undefined && distances.has(step.to)
            }))
        ) {
          expanded.set(id, distances.get(id) ?? 0)
          frontier.delete(id)
        } else {
          frontier.add(id)
        }
      })
      if (sampledStarts.size < startOutcomes.length) {
        progress.startsDone = false
      }
    }

    Array.forEach(order, id => {
      if (!expanded.has(id)) {
        frontier.add(id)
      }
    })
    const status: ReachStatus =
      progress.stopped ??
      (progress.startsDone && Array.isArrayEmpty(Array.fromIterable(frontier))
        ? 'complete'
        : 'depth-limit')
    const result: SearchResult = {
      reach: {
        states: order,
        status,
        counters,
        unfinishedWork: {
          starts: !progress.startsDone,
          states: frontier.size,
          transitions: deferred.size,
        },
      },
      paths,
      edges,
    }
    results.set(cacheKey, { revision: revision.value, result })
    return result
  }

  const reach = (
    depth: number,
    search: Search = 'breadth',
    limits?: Limits,
  ): Reach => run(depth, search, limits).reach

  const interact = (id: string, message: unknown): Option.Option<string> => {
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

  const resolveNext = (id: string, hop: Hop): Option.Option<string> => {
    const current = sourceOf(id)
    const cursor = { index: 0 }
    while (true) {
      const maybeOutcome = pull(current, cursor.index)
      if (Option.isNone(maybeOutcome)) {
        return Option.none()
      }
      if (
        isSameHop(
          {
            ...hop,
            kind: maybeOutcome.value.value.kind,
            decisions: maybeOutcome.value.decisions,
          },
          hop,
        )
      ) {
        return Option.some(
          arrive(nextArrival(nodeOf(id), maybeOutcome.value)).to,
        )
      }
      cursor.index += 1
    }
  }

  const follow = (id: string, hop: Hop): Option.Option<string> =>
    Option.match(hop.maybeMessage, {
      onNone: () => resolveNext(id, hop),
      onSome: encoded =>
        Option.flatMap(decodeMessage(encoded), message =>
          interact(id, message),
        ),
    })

  const resolveStart = (hop: Hop): Option.Option<string> => {
    const cursor = { index: 0 }
    while (true) {
      const maybeOutcome = pull(startSource, cursor.index)
      if (Option.isNone(maybeOutcome)) {
        return Option.none()
      }
      const arrival = startArrival(maybeOutcome.value)
      const step = arrive(arrival)
      if (isSameHop(step, hop)) {
        return Option.some(step.to)
      }
      cursor.index += 1
    }
  }

  const resolve = (address: Address): Option.Option<string> =>
    Array.match(address, {
      onEmpty: () => Option.none(),
      onNonEmpty: ([start, ...hops]) =>
        Array.reduce(hops, resolveStart(start), (maybeId, hop) =>
          Option.flatMap(maybeId, id => follow(id, hop)),
        ),
    })

  const check = (depth: number, limits?: Limits): ReadonlyArray<Violation> => {
    const result = run(depth, 'breadth', limits)
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
    Array.forEach(result.reach.states, id => {
      const node = nodeOf(id)
      const trace = result.paths.get(id) ?? []
      Array.forEach(options.properties ?? [], property => {
        if (property.state !== undefined && !property.state(node)) {
          report({ property: property.name, trace, state: id })
        }
      })
      if (trace.length <= depth) {
        Array.forEach(result.edges.get(id) ?? [], step => {
          const event = messages.get(step)
          if (event !== undefined) {
            Array.forEach(options.properties ?? [], property => {
              if (
                property.transition !== undefined &&
                !property.transition(node, event.message, nodeOf(step.to))
              ) {
                report({
                  property: property.name,
                  trace: Array.append(trace, step),
                  state: step.to,
                })
              }
            })
          }
        })
      }
    })
    return Array.fromIterable(failures.values())
  }

  const groups = (states: ReadonlyArray<string>): ReadonlyArray<Group> => {
    const grouped = new Map<unknown, { home: string; states: Array<string> }>()
    Array.forEach(states, id => {
      const node = nodeOf(id)
      const key =
        environment.inputs === undefined
          ? identity.of(node.model)
          : canonical(inspection(node).screen)
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
    limits,
    propertyNames: Array.map(
      options.properties ?? [],
      property => property.name,
    ),
    check,
    groups,
    grouping:
      'Rendered markup for view-driven environments; equal Models otherwise',
    reach,
    successors,
    knownSuccessors,
    successorStatus: id => {
      nodeOf(id)
      const current = sources.get(id)
      return environment.next === undefined ||
        (current?.done &&
          current.values.every(outcome => {
            const arrival = arrivals.get(outcome)
            return arrival !== undefined && steps.has(arrival)
          }))
        ? 'complete'
        : current === undefined
          ? 'unseen'
          : 'partial'
    },
    interact,
    observe: id => {
      const node = nodeOf(id)
      const inspected = inspection(node)
      return {
        screen: inspected.screen,
        actions: Array.map(inspected.interactions, ({ key, label }) => ({
          key,
          label,
        })),
        pending: describeCommands(node.pending),
      }
    },
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
  const reached = atlas.reach(depth)
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
    ...Array.match(atlas.knownSuccessors(id), {
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
      `# ${atlas.name} · depth ${depth} · ${reached.states.length} states · ${reached.status}`,
      `# Transitions: next(state); limits: ${atlas.limits.states} states, ${atlas.limits.transitions} alternatives (including starts)`,
      ...Array.flatMap(reached.states, stateView),
      '',
    ],
    '\n',
  )
}
