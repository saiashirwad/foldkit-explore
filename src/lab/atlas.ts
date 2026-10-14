import { Array, Option, Predicate, Record, Schema, pipe } from 'effect'
import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineView } from 'foldkit/submodel'

import { canonical } from './canonical'
import { formatValue } from './display'
import { InvalidModelError } from './execution-error'
import {
  type Choices,
  Decision,
  type EnumerationStep,
  type Outcome,
  enumerate,
  replaySteps as replayChoicesSteps,
} from './fixture'
import { makeIdentity } from './identity'
import { type InputDomain, inspect } from './interactions'
import {
  type Observation,
  commandKey,
  describeCommands,
  freezeCommands,
  observationOf,
} from './observation'

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

// NOTE: A Move keeps the pending queue; an Answer consumes exactly its
// selected occurrence.
export const remaining = <Message>(
  pending: Update.Commands<Message>,
  transition: Transition<Message>,
): Update.Commands<Message> =>
  transition.kind === 'Move'
    ? pending
    : Array.filter(
        pending,
        (_command, index) => index !== transition.request.index,
      )

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

export type TransitionEvidence<Message> = Readonly<{
  kind: 'Move' | 'Answer' | 'Event'
  maybeRequest: Option.Option<Request & Readonly<{ occurrence: number }>>
  issued: Update.Commands<Message>
}>

export type Property<Model, Message> = Readonly<{
  id: string
  name: string
  state?: (state: State<Model, Message>) => boolean
  stateApplies?: (state: State<Model, Message>) => boolean
  transition?: (
    before: State<Model, Message>,
    message: Message,
    after: State<Model, Message>,
    evidence: TransitionEvidence<Message>,
  ) => boolean
  transitionApplies?: (
    before: State<Model, Message>,
    message: Message,
    after: State<Model, Message>,
    evidence: TransitionEvidence<Message>,
  ) => boolean
}>

export const registerProperties = <Model, Message>(
  properties: ReadonlyArray<Property<Model, Message>>,
): ReadonlyArray<Property<Model, Message>> => {
  const ids = new Set<string>()
  return Object.freeze(
    Array.map(properties, property => {
      if (property.id.trim() === '') {
        throw new Error('Property identifiers must not be empty.')
      }
      if (ids.has(property.id)) {
        throw new Error(`Duplicate property identifier: ${property.id}.`)
      }
      if (
        typeof property.state !== 'function' &&
        typeof property.transition !== 'function'
      ) {
        throw new Error(
          `Property ${property.id} must declare at least one predicate.`,
        )
      }
      if (
        (property.stateApplies !== undefined && property.state === undefined) ||
        (property.transitionApplies !== undefined &&
          property.transition === undefined)
      ) {
        throw new Error(
          `Property ${property.id}: applicability requires its corresponding predicate.`,
        )
      }
      ids.add(property.id)
      return Object.freeze({ ...property })
    }),
  )
}

export const transitionEvidence = <Message>(
  pending: Update.Commands<Message>,
  transition: Transition<Message>,
  issued: Update.Commands<Message>,
): TransitionEvidence<Message> => ({
  kind: transition.kind,
  issued,
  maybeRequest:
    transition.kind === 'Move'
      ? Option.none()
      : Option.some({
          ...transition.request,
          occurrence: Array.filter(
            pending.slice(0, transition.request.index),
            command =>
              commandKey(command) === commandKey(transition.request.command),
          ).length,
        }),
})

export const Search = Schema.Literals(['breadth', 'depth', 'random'])
export type Search = typeof Search.Type

export type Limits = Readonly<{
  states?: number
  transitions?: number
  enumerationWork?: number
}>
export type ExplorationLimits = Readonly<{
  states: number
  transitions: number
  enumerationWork: number
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

const isSameAddress = (trace: ReadonlyArray<Hop>, address: Address): boolean =>
  trace.length === address.length &&
  trace.every((hop, index) => {
    const other = address[index]
    return (
      other !== undefined &&
      isSameHop(hop, other) &&
      canonical(hop.maybeMessage) === canonical(other.maybeMessage)
    )
  })

// ATLAS

export const StepSnapshot = Schema.Struct({
  ...Hop.fields,
  label: Schema.String,
  to: Schema.String,
})
export type Step = typeof StepSnapshot.Type
export const StateSnapshot = Schema.Struct({
  id: Schema.String,
  model: Schema.Unknown,
  encodedModel: Schema.Unknown,
  address: Address,
  key: Schema.String,
  trace: Schema.Array(StepSnapshot),
  pending: Schema.Array(
    Schema.Struct({ name: Schema.String, args: Schema.String }),
  ),
  next: Schema.Array(StepSnapshot),
  successorStatus: Schema.Literals(['unseen', 'partial', 'complete']),
})
export type StateSnapshot = typeof StateSnapshot.Type
export type ReachStatus =
  | 'complete'
  | 'depth-limit'
  | 'state-limit'
  | 'transition-limit'
  | 'enumeration-limit'
  | 'model-error'
export type SuccessorStatus = 'unseen' | 'partial' | 'complete'

export type Reach = Readonly<{
  states: ReadonlyArray<string>
  status: ReachStatus
  counters: Readonly<{
    states: number
    transitions: number
    starts: number
    enumerationWork: number
  }>
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
export const ReachSnapshot = Schema.Struct({
  states: Schema.Array(Schema.String),
  status: Schema.Literals([
    'complete',
    'depth-limit',
    'state-limit',
    'transition-limit',
    'enumeration-limit',
    'model-error',
  ]),
  counters: Schema.Struct({
    states: Schema.Number,
    transitions: Schema.Number,
    starts: Schema.Number,
    enumerationWork: Schema.Number,
  }),
  unfinishedWork: Schema.Struct({
    starts: Schema.Boolean,
    states: Schema.Number,
    transitions: Schema.Number,
  }),
})
export const Violation = Schema.Struct({
  propertyId: Schema.String,
  property: Schema.String,
  kind: Schema.Literals(['state', 'transition']),
  trace: Schema.Array(StepSnapshot),
  state: Schema.String,
})
export type Violation = typeof Violation.Type
const EvaluationCounts = Schema.Struct({
  considered: Schema.Number,
  applicable: Schema.Number,
  evaluated: Schema.Number,
})
const PropertyError = Schema.Struct({
  kind: Schema.Literals(['state', 'transition']),
  stage: Schema.Literals(['applicability', 'predicate']),
  reason: Schema.String,
  state: Schema.String,
  trace: Schema.Array(StepSnapshot),
})
const CommandEvidence = Schema.Struct({
  name: Schema.String,
  args: Schema.Unknown,
})
const StepEvidenceSnapshot = Schema.Struct({
  kind: Schema.Literals(['Move', 'Answer', 'Event']),
  maybeRequest: Schema.Option(
    Schema.Struct({
      index: Schema.Number,
      occurrence: Schema.Number,
      command: CommandEvidence,
    }),
  ),
  issued: Schema.Array(CommandEvidence),
})
const CheckError = Schema.Struct({
  reason: Schema.String,
  maybeState: Schema.Option(Schema.String),
})
export const CheckReport = Schema.Struct({
  version: Schema.Literal(1),
  coverage: Schema.Struct({
    depth: Schema.Number,
    search: Schema.Literal('breadth'),
    limits: Schema.Struct({
      states: Schema.Number,
      transitions: Schema.Number,
      enumerationWork: Schema.Number,
    }),
    reached: ReachSnapshot,
    starts: Schema.Array(StepSnapshot),
    edges: Schema.Array(
      Schema.Struct({
        from: Schema.String,
        step: StepSnapshot,
        evidence: StepEvidenceSnapshot,
      }),
    ),
    frontier: Schema.Array(Schema.String),
    enumeration: Schema.Array(
      Schema.Struct({
        state: Schema.String,
        status: Schema.Literals(['unseen', 'partial', 'complete']),
      }),
    ),
    assumptions: Schema.Array(Schema.String),
  }),
  errors: Schema.Array(CheckError),
  violations: Schema.Array(Violation),
  properties: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      verdict: Schema.Literals([
        'counterexample',
        'inconclusive',
        'complete',
        'not-exercised',
        'error',
      ]),
      applicability: Schema.Literals(['observed', 'unobserved', 'unreachable']),
      counts: Schema.Struct({
        state: EvaluationCounts,
        transition: EvaluationCounts,
      }),
      maybeWitness: Schema.Option(
        Schema.Struct({
          state: Schema.String,
          trace: Schema.Array(StepSnapshot),
        }),
      ),
      maybeViolation: Schema.Option(Violation),
      errors: Schema.Array(PropertyError),
    }),
  ),
})
export type CheckReport = typeof CheckReport.Type
export type Group = Readonly<{ home: string; states: ReadonlyArray<string> }>

export type Atlas = Readonly<{
  name: string
  limits: ExplorationLimits
  propertyNames: ReadonlyArray<string>
  check: (depth: number, limits?: Limits) => CheckReport
  checkSteps: (depth: number, limits?: Limits) => Generator<void, CheckReport>
  groups: (states: ReadonlyArray<string>) => ReadonlyArray<Group>
  groupSteps: (
    states: ReadonlyArray<string>,
  ) => Generator<void, ReadonlyArray<Group>>
  grouping: string
  reach: (depth: number, search?: Search, limits?: Limits) => Reach
  describe: (depth: number) => string
  successors: (state: string, limits?: Limits) => ReadonlyArray<Step>
  knownSuccessors: (state: string) => ReadonlyArray<Step>
  successorStatus: (state: string) => SuccessorStatus
  interact: (state: string, message: unknown) => Option.Option<string>
  observe: (state: string) => Observation
  trace: (state: string) => ReadonlyArray<Step>
  address: (state: string) => Address
  key: (state: string) => string
  resolve: (address: Address) => Option.Option<string>
  resolveSteps: (address: Address) => Generator<void, Option.Option<string>>
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
  fresh: () => Atlas
  dispose: () => void
  explore: (
    depth: number,
    search?: Search,
    limits?: Limits,
  ) => Generator<void, Reach>
  probe: (
    state: string,
    limits?: Limits,
  ) => Generator<void, ReadonlyArray<Step>>
  snapshot: () => ReadonlyArray<StateSnapshot>
  snapshotSteps: () => Generator<void, ReadonlyArray<StateSnapshot>>
  renderModel: <ParentMessage>(
    model: unknown,
    slot: string,
    h: HtmlBuilder<ParentMessage>,
    toParentMessage: (message: unknown) => ParentMessage,
  ) => Html
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
    evidence?: TransitionEvidence<Message>
  }>

type PreparedArrival<Model, Message, Input> = {
  readonly arrival: Arrival<Model, Message, Input>
  readonly key: unknown
  maybeStep: Option.Option<Step>
}

type Source<Value> = {
  iterator: Iterator<EnumerationStep<Value>>
  work: number
  valueWork: Array<number>
  values: Array<Outcome<Value>>
  done: boolean
  maybeFailure: Option.Option<Readonly<{ cause: unknown; work: number }>>
}

type Read<Value> =
  | Readonly<{ kind: 'value'; outcome: Outcome<Value> }>
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'limit' }>

type SearchResult = Readonly<{
  reach: Reach
  errors: ReadonlyArray<typeof CheckError.Type>
  starts: ReadonlyArray<Step>
  frontier: ReadonlyArray<string>
  enumeration: CheckReport['coverage']['enumeration']
  paths: ReadonlyMap<string, ReadonlyArray<Step>>
  edges: ReadonlyMap<string, ReadonlyArray<Step>>
}>

const source = <Value>(choices: () => Choices<Value>): Source<Value> => ({
  iterator: enumerate(choices),
  work: 0,
  valueWork: [],
  values: [],
  done: false,
  maybeFailure: Option.none(),
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

export const limit = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`)
  }
  return value
}

const limitsOf = (
  override: Limits,
  fallback: ExplorationLimits,
): ExplorationLimits => ({
  states: limit(override.states ?? fallback.states, 'State limit'),
  transitions: limit(
    override.transitions ?? fallback.transitions,
    'Transition limit',
  ),
  enumerationWork: limit(
    override.enumerationWork ?? fallback.enumerationWork,
    'Enumeration work limit',
  ),
})

export const make = <Model, Message, Input = void>(
  program: Program<Model, Message, Input>,
  environment: Environment<Model, Message, Input>,
  options: Options<Model, Message> = {},
): Atlas => {
  const limits = limitsOf(options.limits ?? {}, {
    states: 5_000,
    transitions: 50_000,
    enumerationWork: 1_000_000,
  })
  const properties = registerProperties(options.properties ?? [])
  const identity = makeIdentity()
  const screens = makeIdentity()
  const nodes = new Map<string, Node<Model, Message, Input>>()
  const idOf = new Map<unknown, string>()
  const preparedArrivals = new WeakMap<
    object,
    PreparedArrival<Model, Message, Input>
  >()
  const messages = new WeakMap<
    Step,
    Readonly<{ message: Message; evidence: TransitionEvidence<Message> }>
  >()
  const sources = new Map<string, Source<Transition<Message>>>()
  const inspections = new Map<
    unknown,
    ReturnType<typeof inspect<Model, Message>>
  >()
  const startSource = source(environment.starts)
  const fixtureOptions = new Map<string, ReadonlyArray<string>>()
  const keyOf = new Map<string, string>()
  const lifecycle = { disposed: false }
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

  const nodeOf = (id: string): Node<Model, Message, Input> => {
    if (lifecycle.disposed) {
      throw new Error('Atlas session is disposed.')
    }
    return pipe(
      Option.fromNullishOr(nodes.get(id)),
      Option.getOrThrowWith(() => new Error(`${program.name} has no ${id}.`)),
    )
  }

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

  const prepare = (
    arrival: Arrival<Model, Message, Input>,
  ): PreparedArrival<Model, Message, Input> => {
    freezeCommands(arrival.pending, `${program.name}.pending`)
    const pendingDescription = describeCommands(arrival.pending)
    identity.of(arrival.input, `${program.name}.input`)
    identity.of(arrival.model, `${program.name}.model`)
    if (!Schema.is(program.Model)(arrival.model)) {
      throw new InvalidModelError(
        `${program.name}: invalid Model returned by start/update.`,
      )
    }
    identity.of(pendingDescription, `${program.name}.pending`)
    return {
      arrival,
      key: identity.of([arrival.input, arrival.model, pendingDescription]),
      maybeStep: Option.none(),
    }
  }

  const publishArrival = (
    prepared: PreparedArrival<Model, Message, Input>,
  ): Step => {
    if (Option.isSome(prepared.maybeStep)) {
      return prepared.maybeStep.value
    }
    const { arrival, key } = prepared
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
    prepared.maybeStep = Option.some(step)
    Option.match(arrival.maybeMessageValue, {
      onNone: () => undefined,
      onSome: message => {
        if (arrival.evidence !== undefined) {
          messages.set(step, { message, evidence: arrival.evidence })
        }
      },
    })
    learn(arrival.decisions)
    return step
  }

  const prepareStart = (
    outcome: Outcome<Input>,
  ): PreparedArrival<Model, Message, Input> => {
    const known = preparedArrivals.get(outcome)
    if (known !== undefined) {
      return known
    }
    identity.of(outcome.value, `${program.name}.input`)
    const started = program.start(outcome.value)
    const prepared = prepare({
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
    })
    preparedArrivals.set(outcome, prepared)
    return prepared
  }

  const freezeIssued = (
    issued: Update.Commands<Message>,
  ): Update.Commands<Message> => {
    freezeCommands(issued, `${program.name}.issued`)
    identity.of(describeCommands(issued), `${program.name}.issued`)
    return issued
  }

  const after = (
    node: Node<Model, Message, Input>,
    transition: Transition<Message>,
  ) => {
    const updated = program.update(node.model, transition.message)
    return {
      maybeFrom: Option.some(node),
      input: node.input,
      model: updated.model,
      pending: Array.appendAll(
        remaining(node.pending, transition),
        updated.commands ?? [],
      ),
      maybeMessageValue: Option.some(transition.message),
      evidence: transitionEvidence(
        node.pending,
        transition,
        freezeIssued(updated.commands ?? []),
      ),
    }
  }

  const prepareNext = (
    node: Node<Model, Message, Input>,
    outcome: Outcome<Transition<Message>>,
  ): PreparedArrival<Model, Message, Input> => {
    const known = preparedArrivals.get(outcome)
    if (known !== undefined) {
      return known
    }
    const { decisions, value } = outcome
    if (!isMessage(value.message)) {
      throw new Error(`${program.name}: next returned an invalid Message.`)
    }
    if (
      value.kind === 'Answer' &&
      node.pending[value.request.index] !== value.request.command
    ) {
      throw new Error(
        `${program.name}: answer must select a pending Command from this state.`,
      )
    }
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
    const prepared = prepare({
      kind: value.kind,
      decisions,
      maybeMessage: Option.none(),
      label:
        value.kind === 'Move'
          ? label
          : `${value.request.command.name} #${value.request.index + 1} ${label}`.trimEnd(),
      ...after(node, value),
    })
    preparedArrivals.set(outcome, prepared)
    return prepared
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
              Array.empty<EnumerationStep<Transition<Message>>>()[
                Symbol.iterator
              ](),
            work: 0,
            valueWork: [],
            values: [],
            done: true,
            maybeFailure: Option.none(),
          }
        : source(() =>
            next({
              input: node.input,
              model: node.model,
              pending: node.pending,
              interactions:
                environment.inputs === undefined
                  ? {}
                  : Record.fromIterableWith(
                      inspection(node).interactions,
                      ({ key, message }) => [key, message],
                    ),
            }),
          )
    sources.set(id, current)
    return current
  }

  const pullSteps = function* <Value>(
    current: Source<Value>,
    index: number,
    charge: (work: number) => boolean = () => true,
  ): Generator<void, Read<Value>> {
    while (true) {
      const known = current.values[index]
      if (known !== undefined) {
        return charge(current.valueWork[index] ?? current.work)
          ? { kind: 'value', outcome: known }
          : { kind: 'limit' }
      }
      if (Option.isSome(current.maybeFailure)) {
        if (!charge(current.maybeFailure.value.work)) {
          return { kind: 'limit' }
        }
        throw current.maybeFailure.value.cause
      }
      if (current.done) {
        return charge(current.work) ? { kind: 'done' } : { kind: 'limit' }
      }
      if (!charge(current.work + 1)) {
        return { kind: 'limit' }
      }
      yield
      const advance = () => {
        try {
          return current.iterator.next()
        } catch (error) {
          current.work += 1
          revision.value += 1
          current.maybeFailure = Option.some({
            cause: error,
            work: current.work,
          })
          throw error
        }
      }
      const item = advance()
      current.work += 1
      revision.value += 1
      if (item.done) {
        current.done = true
      } else if (item.value.kind === 'outcome') {
        current.values.push(item.value.outcome)
        current.valueWork.push(current.work)
      }
    }
  }

  const finish = <Value>(iterator: Generator<void, Value>): Value => {
    const cursor = { step: iterator.next() }
    while (!cursor.step.done) {
      cursor.step = iterator.next()
    }
    return cursor.step.value
  }
  const pull = <Value>(
    current: Source<Value>,
    index: number,
    charge?: (work: number) => boolean,
  ): Read<Value> => finish(pullSteps(current, index, charge))

  const knownStep = <Value>(outcome: Outcome<Value>): Option.Option<Step> =>
    preparedArrivals.get(outcome)?.maybeStep ?? Option.none()

  const knownSuccessors = (id: string): ReadonlyArray<Step> => {
    nodeOf(id)
    return Array.getSomes(Array.map(sources.get(id)?.values ?? [], knownStep))
  }

  const probe = function* (
    id: string,
    override: Limits = {},
  ): Generator<void, ReadonlyArray<Step>> {
    const node = nodeOf(id)
    const bound = limitsOf(override, limits)
    const admitted = new Set([id])
    const result: Array<Step> = []
    if (bound.states === 0) {
      return result
    }
    const current = sourceOf(id)
    const cursor = { index: 0 }
    while (cursor.index < bound.transitions) {
      yield
      const item = yield* pullSteps(
        current,
        cursor.index,
        work => work <= bound.enumerationWork,
      )
      if (item.kind !== 'value') {
        return result
      }
      const prepared = prepareNext(node, item.outcome)
      const known = idOf.get(prepared.key)
      if (
        (known === undefined || !admitted.has(known)) &&
        admitted.size >= bound.states
      ) {
        return result
      }
      const step = publishArrival(prepared)
      admitted.add(step.to)
      result.push(step)
      cursor.index += 1
    }
    return result
  }

  const successors = (state: string, limits?: Limits): ReadonlyArray<Step> =>
    finish(probe(state, limits))

  const runSteps = function* (
    requestedDepth: number,
    search: Search = 'breadth',
    override: Limits = {},
    captureErrors = false,
  ): Generator<void, SearchResult> {
    if (lifecycle.disposed) {
      throw new Error('Atlas session is disposed.')
    }
    const depth = limit(requestedDepth, 'Depth')
    const bound = limitsOf(override, limits)
    const cacheKey = `${search} ${depth} ${bound.states} ${bound.transitions} ${bound.enumerationWork} ${captureErrors}`
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
    const counters = {
      states: 0,
      transitions: 0,
      starts: 0,
      enumerationWork: 0,
    }
    const enumerationCharges = new Map<object, number>()
    const progress: {
      stopped:
        | 'state-limit'
        | 'transition-limit'
        | 'enumeration-limit'
        | 'model-error'
        | undefined
      startsDone: boolean
      startIndex: number
    } = {
      stopped: undefined,
      startsDone: false,
      startIndex: 0,
    }

    const errors: Array<typeof CheckError.Type> = []
    const attempt = (
      prepare: () => PreparedArrival<Model, Message, Input>,
      maybeState: Option.Option<string> = Option.none(),
    ): PreparedArrival<Model, Message, Input> | undefined => {
      try {
        return prepare()
      } catch (error) {
        if (!captureErrors) {
          throw error
        }
        errors.push({
          reason: error instanceof Error ? error.message : String(error),
          maybeState,
        })
        progress.stopped = 'model-error'
        return undefined
      }
    }
    const read = function* <Value>(
      current: Source<Value>,
      index: number,
      isStart = false,
      maybeState: Option.Option<string> = Option.none(),
    ): Generator<void, Read<Value>> {
      const known = current.values[index]
      if (
        (known === undefined ? !current.done : !charged.has(known)) &&
        counters.transitions >= bound.transitions
      ) {
        progress.stopped = 'transition-limit'
        return { kind: 'limit' }
      }
      yield
      const readResult: { item: Read<Value> } = { item: { kind: 'limit' } }
      try {
        readResult.item = yield* pullSteps(current, index, work => {
          const charged = enumerationCharges.get(current) ?? 0
          const additional = Math.max(0, work - charged)
          const available = bound.enumerationWork - counters.enumerationWork
          const consumed = Math.min(additional, available)
          counters.enumerationWork += consumed
          enumerationCharges.set(current, charged + consumed)
          return additional <= available
        })
      } catch (error) {
        if (!captureErrors) {
          throw error
        }
        errors.push({
          reason: error instanceof Error ? error.message : String(error),
          maybeState,
        })
        progress.stopped = 'model-error'
        return { kind: 'limit' }
      }
      const item = readResult.item
      if (item.kind !== 'value') {
        if (item.kind === 'limit') {
          progress.stopped = 'enumeration-limit'
        }
        return item
      }
      const outcome = item.outcome
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
      prepared: PreparedArrival<Model, Message, Input> | undefined,
      distance: number,
    ): Option.Option<Step> => {
      if (prepared === undefined) {
        return Option.none()
      }
      const knownId = idOf.get(prepared.key)
      const knownDistance =
        knownId === undefined ? undefined : distances.get(knownId)
      if (knownDistance === undefined && distance > depth) {
        deferred.add(prepared)
        return Option.none()
      }
      if (knownDistance === undefined && order.length >= bound.states) {
        deferred.add(prepared)
        progress.stopped = 'state-limit'
        return Option.none()
      }
      deferred.delete(prepared)
      const step = publishArrival(prepared)
      if (knownDistance === undefined) {
        order.push(step.to)
        counters.states += 1
      }
      if (knownDistance === undefined || distance < knownDistance) {
        distances.set(step.to, distance)
        const prefix = Option.match(prepared.arrival.maybeFrom, {
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

    const starts: Array<Step> = []
    const startOutcomes: Array<Outcome<Input>> = []
    while (progress.stopped === undefined && !progress.startsDone) {
      const item = yield* read(startSource, progress.startIndex, true)
      if (item.kind === 'done') {
        progress.startsDone = true
      } else if (item.kind === 'value') {
        startOutcomes.push(item.outcome)
        if (search !== 'random') {
          const step = admit(
            attempt(() => prepareStart(item.outcome)),
            0,
          )
          if (Option.isSome(step)) {
            starts.push(step.value)
          }
        }
        progress.startIndex += 1
      }
    }

    const expand = function* (
      id: string,
      distance: number,
    ): Generator<void, void> {
      const current = sourceOf(id)
      const node = nodeOf(id)
      const cursor = { index: 0, done: false }
      frontier.add(id)
      while (progress.stopped === undefined && !cursor.done) {
        const item = yield* read(current, cursor.index, false, Option.some(id))
        if (item.kind === 'done') {
          expanded.set(id, distance)
          frontier.delete(id)
          cursor.done = true
        } else if (item.kind === 'value') {
          const maybeStep = admit(
            attempt(() => prepareNext(node, item.outcome), Option.some(id)),
            distance + 1,
          )
          if (Option.isSome(maybeStep)) {
            record(id, maybeStep.value)
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
          yield* expand(id, distances.get(id) ?? 0)
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
        const item = yield* read(
          sourceOf(frame.id),
          frame.index,
          false,
          Option.some(frame.id),
        )
        if (item.kind === 'done') {
          frontier.delete(frame.id)
          frames.pop()
        } else if (item.kind === 'value') {
          frame.index += 1
          const maybeStep = admit(
            attempt(
              () => prepareNext(nodeOf(frame.id), item.outcome),
              Option.some(frame.id),
            ),
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
      for (const seed of Array.range(1, WALKS)) {
        if (progress.stopped !== undefined) {
          continue
        }
        const next = random(seed)
        const starting =
          startOutcomes[Math.floor(next() * startOutcomes.length)]
        if (starting === undefined) {
          continue
        }
        sampledStarts.add(starting)
        const walk = {
          at: admit(
            attempt(() => prepareStart(starting)),
            0,
          ),
          distance: 0,
        }
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
            const item = yield* read(
              current,
              cursor.index,
              false,
              Option.some(id),
            )
            if (item.kind === 'done') {
              cursor.done = true
            } else if (item.kind === 'value') {
              offered.push(item.outcome)
              cursor.index += 1
            }
          }
          if (progress.stopped !== undefined) {
            continue
          }
          const selected = offered[Math.floor(next() * offered.length)]
          if (selected === undefined) {
            frontier.delete(id)
            expanded.set(id, walk.distance)
            walk.at = Option.none()
          } else {
            walk.at = admit(
              attempt(() => prepareNext(nodeOf(id), selected), Option.some(id)),
              walk.distance + 1,
            )
            if (Option.isSome(walk.at)) {
              record(id, walk.at.value)
            }
            walk.distance += 1
          }
        }
      }
      Array.forEach(order, id => {
        const current = sources.get(id)
        if (
          environment.next === undefined ||
          (current?.done &&
            current.values.every(outcome =>
              Option.exists(knownStep(outcome), step => distances.has(step.to)),
            ))
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
      (progress.startsDone && frontier.size === 0 ? 'complete' : 'depth-limit')
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
      errors,
      starts,
      frontier: Array.fromIterable(frontier),
      enumeration: Array.map(order, state => ({
        state,
        status:
          expanded.has(state) && !frontier.has(state)
            ? 'complete'
            : edges.has(state) ||
                enumerationCharges.has(sources.get(state) ?? {})
              ? 'partial'
              : 'unseen',
      })),
      paths,
      edges,
    }
    results.set(cacheKey, { revision: revision.value, result })
    return result
  }

  const run = (
    depth: number,
    search: Search = 'breadth',
    limits?: Limits,
  ): SearchResult => finish(runSteps(depth, search, limits))

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
      publishArrival(
        prepare({
          kind: 'Event',
          decisions: [],
          maybeMessage: Option.some(encodeMessage(message)),
          label: tagOf(message),
          ...after(node, send(message)),
        }),
      ).to,
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
      const item = pull(current, cursor.index)
      if (item.kind !== 'value') {
        return Option.none()
      }
      if (
        isSameHop(
          {
            ...hop,
            kind: item.outcome.value.kind,
            decisions: item.outcome.decisions,
          },
          hop,
        )
      ) {
        return Option.some(
          publishArrival(prepareNext(nodeOf(id), item.outcome)).to,
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
      const item = pull(startSource, cursor.index)
      if (item.kind !== 'value') {
        return Option.none()
      }
      const step = publishArrival(prepareStart(item.outcome))
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

  const resolveSteps = function* (
    address: Address,
  ): Generator<void, Option.Option<string>> {
    if (lifecycle.disposed) {
      throw new Error('Atlas session is disposed.')
    }
    const known = Array.fromIterable(nodes.values()).find(node =>
      isSameAddress(node.trace, address),
    )
    if (known !== undefined) {
      return Option.some(known.id)
    }
    const first = address[0]
    if (first === undefined || first.kind !== 'Start') {
      return Option.none()
    }
    const input = yield* replayChoicesSteps(environment.starts, first.decisions)
    const current = {
      id: publishArrival(
        prepareStart({ decisions: first.decisions, value: input }),
      ).to,
    }
    for (const hop of address.slice(1)) {
      yield
      if (hop.kind === 'Event') {
        if (Option.isNone(hop.maybeMessage)) {
          return Option.none()
        }
        const message = decodeMessage(hop.maybeMessage.value)
        if (Option.isNone(message)) {
          return Option.none()
        }
        const next = interact(current.id, message.value)
        if (Option.isNone(next)) {
          return Option.none()
        }
        current.id = next.value
      } else {
        const next = environment.next
        if (next === undefined) {
          return Option.none()
        }
        const node = nodeOf(current.id)
        const transition = yield* replayChoicesSteps(
          () =>
            next({
              input: node.input,
              model: node.model,
              pending: node.pending,
              interactions:
                environment.inputs === undefined
                  ? {}
                  : Record.fromIterableWith(
                      inspection(node).interactions,
                      ({ key, message }) => [key, message],
                    ),
            }),
          hop.decisions,
        )
        if (transition.kind !== hop.kind) {
          return Option.none()
        }
        current.id = publishArrival(
          prepareNext(node, { decisions: hop.decisions, value: transition }),
        ).to
      }
    }
    return Option.some(current.id)
  }

  const atlasLimits = limits
  const checkSteps = function* (
    depth: number,
    limits?: Limits,
  ): Generator<void, CheckReport> {
    const result = yield* runSteps(depth, 'breadth', limits, true)
    const failures = new Map<string, Violation>()
    const summaries = Array.map(properties, property => ({
      property,
      counts: {
        state: { considered: 0, applicable: 0, evaluated: 0 },
        transition: { considered: 0, applicable: 0, evaluated: 0 },
      },
      maybeWitness:
        Option.none<Readonly<{ state: string; trace: ReadonlyArray<Step> }>>(),
      errors: Array.empty<typeof PropertyError.Type>(),
    }))
    const evaluate = (
      summary: (typeof summaries)[number],
      kind: 'state' | 'transition',
      state: string,
      trace: ReadonlyArray<Step>,
      applies: () => boolean,
      predicate: () => boolean,
    ) => {
      const counts = summary.counts[kind]
      counts.considered += 1
      const evaluation: { stage: 'applicability' | 'predicate' } = {
        stage: 'applicability',
      }
      try {
        if (!applies()) {
          return
        }
        counts.applicable += 1
        if (
          Option.isNone(summary.maybeWitness) ||
          trace.length < summary.maybeWitness.value.trace.length
        ) {
          summary.maybeWitness = Option.some({ state, trace })
        }
        evaluation.stage = 'predicate'
        counts.evaluated += 1
        if (!predicate()) {
          const previous = failures.get(summary.property.id)
          if (previous === undefined || trace.length < previous.trace.length) {
            failures.set(summary.property.id, {
              propertyId: summary.property.id,
              property: summary.property.name,
              kind,
              trace,
              state,
            })
          }
        }
      } catch (error) {
        summary.errors.push({
          kind,
          stage: evaluation.stage,
          reason: error instanceof Error ? error.message : String(error),
          state,
          trace,
        })
      }
    }
    const edges: Array<CheckReport['coverage']['edges'][number]> = []
    for (const id of result.reach.states) {
      yield
      const node = nodeOf(id)
      const trace = result.paths.get(id) ?? []
      for (const summary of summaries) {
        yield
        const property = summary.property
        const predicate = property.state
        if (predicate !== undefined) {
          evaluate(
            summary,
            'state',
            id,
            trace,
            () => property.stateApplies?.(node) ?? true,
            () => predicate(node),
          )
        }
      }
      for (const step of result.edges.get(id) ?? []) {
        yield
        const event = messages.get(step)
        if (event === undefined) {
          continue
        }
        const evidence = event.evidence
        edges.push({
          from: id,
          step,
          evidence: {
            kind: evidence.kind,
            issued: describeCommands(evidence.issued),
            maybeRequest: Option.map(evidence.maybeRequest, request => ({
              index: request.index,
              occurrence: request.occurrence,
              command: {
                name: request.command.name,
                args: request.command.args ?? {},
              },
            })),
          },
        })
        for (const summary of summaries) {
          yield
          const property = summary.property
          const predicate = property.transition
          if (predicate !== undefined) {
            const after = nodeOf(step.to)
            evaluate(
              summary,
              'transition',
              step.to,
              Array.append(trace, step),
              () =>
                property.transitionApplies?.(
                  node,
                  event.message,
                  after,
                  evidence,
                ) ?? true,
              () => predicate(node, event.message, after, evidence),
            )
          }
        }
      }
    }
    const report: CheckReport = {
      version: 1,
      coverage: {
        depth,
        search: 'breadth',
        limits: limitsOf(limits ?? {}, atlasLimits),
        reached: result.reach,
        starts: result.starts,
        edges,
        frontier: result.frontier,
        enumeration: result.enumeration,
        assumptions: [
          'Declared finite environment choices only.',
          'Pure programs and immutable supported execution data.',
          'One-shot Command replies; interrupts, subscriptions and resources are not automatically modeled.',
        ],
      },
      errors: result.errors,
      violations: Array.fromIterable(failures.values()),
      properties: Array.map(summaries, summary => {
        const maybeViolation = Option.fromNullishOr(
          failures.get(summary.property.id),
        )
        const exercised =
          summary.counts.state.applicable +
            summary.counts.transition.applicable >
          0
        return {
          id: summary.property.id,
          name: summary.property.name,
          verdict:
            Array.isReadonlyArrayNonEmpty(result.errors) ||
            Array.isArrayNonEmpty(summary.errors)
              ? 'error'
              : Option.isSome(maybeViolation)
                ? 'counterexample'
                : !exercised
                  ? 'not-exercised'
                  : result.reach.status === 'complete'
                    ? 'complete'
                    : 'inconclusive',
          applicability: exercised
            ? 'observed'
            : result.reach.status === 'complete' &&
                !Array.some(
                  summary.errors,
                  error => error.stage === 'applicability',
                )
              ? 'unreachable'
              : 'unobserved',
          counts: summary.counts,
          maybeWitness: summary.maybeWitness,
          maybeViolation,
          errors: summary.errors,
        }
      }),
    }
    identity.of(report, `${program.name}.check`)
    return report
  }

  const check = (depth: number, limits?: Limits): CheckReport =>
    finish(checkSteps(depth, limits))

  const groupSteps = function* (
    states: ReadonlyArray<string>,
  ): Generator<void, ReadonlyArray<Group>> {
    const grouped = new Map<unknown, { home: string; states: Array<string> }>()
    for (const id of states) {
      yield
      const node = nodeOf(id)
      const key =
        environment.inputs === undefined
          ? identity.of(node.model)
          : screens.of(inspection(node).screen)
      const known = grouped.get(key)
      if (known !== undefined) {
        known.states.push(id)
      } else {
        grouped.set(key, { home: id, states: [id] })
      }
    }
    return Array.fromIterable(grouped.values())
  }

  const groups = (states: ReadonlyArray<string>): ReadonlyArray<Group> =>
    finish(groupSteps(states))

  const describeReach = (depth: number): string => {
    const { reach: reached, edges } = run(depth, 'breadth')
    const stateView = (id: string) => [
      '',
      `${id}  ${Array.join(
        Array.map(nodeOf(id).trace, step => step.label),
        ' › ',
      )}`,
      `    ${formatValue(encodeModel(nodeOf(id).model))}`,
      ...Array.map(
        nodeOf(id).pending,
        command =>
          `    pending ${command.name} ${formatValue(command.args ?? {})}`,
      ),
      ...Array.match(edges.get(id) ?? [], {
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
        `# ${program.name} · depth ${depth} · ${reached.states.length} states · ${reached.status}`,
        `# Transitions: next(state); limits: ${limits.states} states, ${limits.transitions} alternatives (including starts)`,
        ...Array.flatMap(reached.states, stateView),
        '',
      ],
      '\n',
    )
  }

  const successorStatus = (id: string): SuccessorStatus => {
    nodeOf(id)
    const current = sources.get(id)
    return environment.next === undefined ||
      (current?.done &&
        current.values.every(outcome => Option.isSome(knownStep(outcome))))
      ? 'complete'
      : current === undefined
        ? 'unseen'
        : 'partial'
  }
  const snapshotSteps = function* (): Generator<
    void,
    ReadonlyArray<StateSnapshot>
  > {
    const result: Array<StateSnapshot> = []
    for (const node of nodes.values()) {
      yield
      result.push({
        id: node.id,
        model: node.model,
        encodedModel: encodeModel(node.model),
        address: address(node.id),
        key: key(node.id),
        trace: node.trace,
        pending: Array.map(node.pending, command => ({
          name: command.name,
          args: formatValue(command.args ?? {}),
        })),
        next: knownSuccessors(node.id),
        successorStatus: successorStatus(node.id),
      })
    }
    return result
  }
  const snapshot = (): ReadonlyArray<StateSnapshot> => finish(snapshotSteps())

  return {
    name: program.name,
    describe: describeReach,
    limits,
    propertyNames: Array.map(properties, property => property.name),
    check,
    checkSteps,
    groups,
    groupSteps,
    grouping:
      'Rendered markup for view-driven environments; equal Models otherwise',
    reach,
    successors,
    knownSuccessors,
    successorStatus,
    interact,
    observe: id => {
      const node = nodeOf(id)
      return observationOf(inspection(node), node.pending)
    },
    trace: id => nodeOf(id).trace,
    address,
    key,
    resolve,
    resolveSteps,
    pending: id =>
      Array.map(nodeOf(id).pending, command => ({
        name: command.name,
        args: formatValue(command.args ?? {}),
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
    fresh: () => make(program, environment, options),
    dispose: () => {
      if (lifecycle.disposed) {
        return
      }
      lifecycle.disposed = true
      const iterators: ReadonlyArray<Iterator<unknown>> = [
        startSource.iterator,
        ...Array.map(
          Array.fromIterable(sources.values()),
          current => current.iterator,
        ),
      ]
      const errors = Array.flatMap(iterators, iterator => {
        try {
          iterator.return?.()
          return []
        } catch (error) {
          return [error]
        }
      })
      startSource.values.length = 0
      startSource.valueWork.length = 0
      identity.clear()
      screens.clear()
      nodes.clear()
      idOf.clear()
      sources.clear()
      inspections.clear()
      results.clear()
      fixtureOptions.clear()
      keyOf.clear()
      if (Array.isArrayNonEmpty(errors)) {
        throw new AggregateError(errors, 'Atlas cleanup failed.')
      }
    },
    explore: function* (depth, search, limits) {
      return (yield* runSteps(depth, search, limits)).reach
    },
    snapshot,
    snapshotSteps,
    probe,
    renderModel: (model, slot, h, toParentMessage) => {
      if (!Schema.is(program.Model)(model)) {
        throw new InvalidModelError(`${program.name}: invalid preview Model.`)
      }
      return h.submodel({ slotId: slot, model, view, toParentMessage })
    },
  }
}

// DESCRIBE

export const describe = (atlas: Atlas, depth: number): string =>
  atlas.describe(depth)
