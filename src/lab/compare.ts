import { Array, Predicate, Record, Schema } from 'effect'
import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineView } from 'foldkit/submodel'

import {
  type Environment,
  type Program,
  type Property,
  type ReachStatus,
  type SuccessorStatus,
  type Transition,
  limit,
  registerProperties,
  remaining,
  transitionEvidence,
} from './atlas'
import { canonical, ownDataEntries } from './canonical'
import { formatValue } from './display'
import { InvalidModelError } from './execution-error'
import {
  type Choices,
  type Decision,
  type EnumerationStep,
  type Outcome,
  enumerate,
  replaySteps as replayChoicesSteps,
} from './fixture'
import { isStructural, makeIdentity } from './identity'
import { inspect } from './interactions'
import {
  type CommandDescription,
  type Observation,
  commandKey,
  describeCommands,
  freezeCommands,
  observationOf,
} from './observation'
import {
  ReplayDivergenceError,
  type ReplayOptions,
  boundedReplaySteps,
  finishReplay,
} from './replay'

export type ComparisonSide = 'before' | 'after'

export type ComparisonStatus = ReachStatus | 'pair-limit' | 'running'

// NOTE: States are capped independently on each side. The pair cap defaults
// to the state cap. Transitions count a shared start once and every consumed
// event alternative on either side, including alternatives that revisit states.
export type ComparisonLimits = Readonly<{
  depth: number
  states: number
  transitions: number
  pairs?: number
  enumerationWork?: number
}>

export type ComparisonCounters = Readonly<{
  starts: number
  beforeStates: number
  afterStates: number
  pairs: number
  transitions: number
  beforeTransitions: number
  afterTransitions: number
  enumerationWork: number
  joinOperations: number
}>

export type Execution = Readonly<{
  id: string
  input: unknown
  model: unknown
  pending: ReadonlyArray<CommandDescription>
  observation: Observation
}>

export type ComparisonEvent = Readonly<{
  kind: 'Move' | 'Answer'
  key: string
  label: string
  message: unknown
  decisions: ReadonlyArray<Decision>
  request?: Readonly<{
    command: CommandDescription
    occurrence: number
    index: number
  }>
}>

export type ComparisonStep = Readonly<{
  kind: 'Start' | 'Transition'
  label: string
  startDecisions: ReadonlyArray<Decision>
  before?: Execution | undefined
  after?: Execution | undefined
  beforeEvent?: ComparisonEvent | undefined
  afterEvent?: ComparisonEvent | undefined
  beforeIssued: ReadonlyArray<CommandDescription>
  afterIssued: ReadonlyArray<CommandDescription>
}>

export type ComparisonTrace = ReadonlyArray<ComparisonStep>

export type ComparisonExample = Readonly<{
  id: string
  pair: string
  depth: number
  trace: ComparisonTrace
  before?: Execution | undefined
  after?: Execution | undefined
}>

export type FindingKind =
  | 'content'
  | 'action-added'
  | 'action-removed'
  | 'action-changed'
  | 'pending'
  | 'commands'
  | 'event-added'
  | 'event-removed'
  | 'property'

export type ComparisonFinding = Readonly<{
  id: string
  kind: FindingKind
  title: string
  description: string
  before: unknown
  after: unknown
  examples: ReadonlyArray<ComparisonExample>
  shortest: ComparisonExample
}>

export type PropertyFailure = Readonly<{
  propertyId: string
  property: string
  side: ComparisonSide
  kind: 'state' | 'transition'
  example: ComparisonExample
}>

export type UnfinishedComparisonWork = Readonly<{
  kind: 'starts' | 'pair'
  pair: string
  depth: number
  before: SuccessorStatus
  after: SuccessorStatus
  beforeAlternatives: number
  afterAlternatives: number
}>

export type Comparison = Readonly<{
  name: string
  status: ComparisonStatus
  limits: Required<ComparisonLimits>
  counters: ComparisonCounters
  findings: ReadonlyArray<ComparisonFinding>
  propertyFailures: ReadonlyArray<PropertyFailure>
  unfinishedWork: ReadonlyArray<UnfinishedComparisonWork>
  resume: (limits: ComparisonLimits) => Comparison
  setLimits: (limits: ComparisonLimits) => void
  advance: (steps: number) => boolean
  dispose: () => void
  replay: (trace: ComparisonTrace, options?: ReplayOptions) => ComparisonTrace
  replaySteps: (
    trace: ComparisonTrace,
    options?: ReplayOptions,
  ) => Generator<void, ComparisonTrace>
  render: <ParentMessage>(
    side: ComparisonSide,
    example: ComparisonExample,
    traceIndex: number,
    slot: string,
    h: HtmlBuilder<ParentMessage>,
    toParentMessage: (message: unknown) => ParentMessage,
  ) => Html
}>

type Node<Model, Message, Input> = Readonly<{
  id: string
  key: unknown
  model: Model
  pending: Update.Commands<Message>
  input: Input
  context: ReadonlyArray<Decision>
  evidence: Execution
  interactions: Readonly<Record<string, Message>>
}>

type Event<Message> = Readonly<{
  transition: Transition<Message>
  evidence: ComparisonEvent
}>

type Prepared<Model, Message, Input> = Readonly<{
  node: Node<Model, Message, Input>
  issued: ReadonlyArray<CommandDescription>
  issuedCommands: Update.Commands<Message>
}>

type Enumeration<Message> = {
  iterator: Iterator<EnumerationStep<Transition<Message>>> | undefined
  status: SuccessorStatus
  events: Map<string, Event<Message>>
}

type Pair<BeforeModel, AfterModel, Message, Input> = {
  id: string
  before: Node<BeforeModel, Message, Input>
  after: Node<AfterModel, Message, Input>
  trace: ComparisonTrace
  depth: number
  beforeEvents: Enumeration<Message>
  afterEvents: Enumeration<Message>
  ready: Array<string>
  nextReady: number
  reconciled: boolean
  turn: ComparisonSide
  buffered:
    | Readonly<{
        key: string
        beforeEvent: Event<Message> | undefined
        afterEvent: Event<Message> | undefined
        before: Prepared<BeforeModel, Message, Input> | undefined
        after: Prepared<AfterModel, Message, Input> | undefined
      }>
    | undefined
}

type Change = Readonly<{ path: string; before: unknown; after: unknown }>

const commonPrefix = (
  before: ReadonlyArray<unknown>,
  after: ReadonlyArray<unknown>,
): number => {
  const different = before.findIndex(
    (value, index) =>
      index >= after.length || canonical(value) !== canonical(after[index]),
  )
  return different < 0 ? before.length : different
}

const changes = (
  before: unknown,
  after: unknown,
  path = 'screen',
): ReadonlyArray<Change> => {
  if (Object.is(before, after) || canonical(before) === canonical(after)) {
    return []
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) {
      return Array.flatMap(before, (value, index) =>
        changes(value, after[index], `${path}[${index}]`),
      )
    }
    const prefix = commonPrefix(before, after)
    const suffix = commonPrefix(
      before.slice(prefix).reverse(),
      after.slice(prefix).reverse(),
    )
    return [
      {
        path: `${path}[${prefix}]`,
        before: before.slice(prefix, before.length - suffix),
        after: after.slice(prefix, after.length - suffix),
      },
    ]
  }
  if (
    Predicate.isObject(before) &&
    Predicate.isObject(after) &&
    isStructural(before) &&
    isStructural(after)
  ) {
    const left = new Map(ownDataEntries(before))
    const right = new Map(ownDataEntries(after))
    return Array.flatMap(
      Array.dedupe([...left.keys(), ...right.keys()]),
      key =>
        left.has(key) && right.has(key)
          ? changes(left.get(key), right.get(key), `${path}.${key}`)
          : [
              {
                path: `${path}.${key}`,
                before: { present: left.has(key), value: left.get(key) },
                after: { present: right.has(key), value: right.get(key) },
              },
            ],
    )
  }
  return [{ path, before, after }]
}

const actionLabel = (label: string): string => label.replace(/^click /, '')

const actionsByLabel = (actions: Observation['actions']) => {
  const grouped = new Map<string, Array<Observation['actions'][number]>>()
  Array.forEach(actions, action => {
    const known = grouped.get(action.label)
    if (known === undefined) {
      grouped.set(action.label, [action])
    } else {
      known.push(action)
    }
  })
  return grouped
}

const messageLabel = (message: unknown): string =>
  Predicate.hasProperty(message, '_tag') && typeof message._tag === 'string'
    ? message._tag
    : typeof message === 'string'
      ? message
      : message === undefined
        ? 'absent'
        : formatValue(message)

const commandsKeys = new WeakMap<ReadonlyArray<CommandDescription>, string>()

const commandsKey = (commands: ReadonlyArray<CommandDescription>): string => {
  const known = commandsKeys.get(commands)
  if (known !== undefined) {
    return known
  }
  const key = canonical(Array.map(commands, commandKey).sort())
  commandsKeys.set(commands, key)
  return key
}

const commandDifference = (
  before: ReadonlyArray<CommandDescription>,
  after: ReadonlyArray<CommandDescription>,
) => {
  const counts = (commands: ReadonlyArray<CommandDescription>) => {
    const result = new Map<
      string,
      { command: CommandDescription; count: number }
    >()
    Array.forEach(commands, command => {
      const key = commandKey(command)
      result.set(key, { command, count: (result.get(key)?.count ?? 0) + 1 })
    })
    return result
  }
  const left = counts(before)
  const right = counts(after)
  const unmatched = (from: typeof left, to: typeof right) =>
    Array.flatMap(Array.fromIterable(from.keys()).sort(), key => {
      const entry = from.get(key)
      const count = (entry?.count ?? 0) - (to.get(key)?.count ?? 0)
      return entry === undefined || count <= 0
        ? []
        : Array.makeBy(count, () => entry.command)
    })
  return { before: unmatched(left, right), after: unmatched(right, left) }
}

const enumeration = <Message>(): Enumeration<Message> => ({
  iterator: undefined,
  status: 'unseen',
  events: new Map(),
})

const normalizedLimits = (
  limits: ComparisonLimits,
): Required<ComparisonLimits> => ({
  depth: limit(limits.depth, 'Depth'),
  states: limit(limits.states, 'State limit'),
  transitions: limit(limits.transitions, 'Transition limit'),
  pairs: limit(limits.pairs ?? limits.states, 'Pair limit'),
  enumerationWork: limit(
    limits.enumerationWork ?? 1_000_000,
    'Enumeration work limit',
  ),
})

export type ComparisonOptions<
  BeforeModel,
  AfterModel,
  Message,
  Input = void,
> = Readonly<{
  before: Program<BeforeModel, Message, Input>
  after: Program<AfterModel, Message, Input>
  environment: Environment<BeforeModel | AfterModel, Message, Input>
  properties?: ReadonlyArray<Property<BeforeModel | AfterModel, Message>>
  limits: ComparisonLimits
}>

export const compare = <BeforeModel, AfterModel, Message, Input = void>(
  options: ComparisonOptions<BeforeModel, AfterModel, Message, Input>,
): Comparison => {
  const comparison = createComparison(options)
  comparison.resume(options.limits)
  return comparison
}

export const createComparison = <
  BeforeModel,
  AfterModel,
  Message,
  Input = void,
>(
  options: ComparisonOptions<BeforeModel, AfterModel, Message, Input>,
): Comparison => {
  const { environment } = options
  const properties = registerProperties(options.properties ?? [])
  const identity = makeIdentity()
  type InspectionCache = Map<
    unknown,
    Map<unknown, Map<unknown, ReturnType<typeof inspect<unknown, Message>>>>
  >
  const inspectionCache: InspectionCache = new Map()
  const screenDeltas = new Map<string, ReadonlyArray<Change>>()
  const makeRuntime = <Model extends BeforeModel | AfterModel>(
    program: Program<Model, Message, Input>,
    prefix: string,
    inspections = inspectionCache,
  ) => {
    const nodes = new Map<unknown, Node<Model, Message, Input>>()
    const isMessage = Schema.is(program.Message)
    const encodeMessage = Schema.encodeSync(program.Message)
    const isModel = Schema.is(program.Model)
    const encodeModel = Schema.encodeSync(program.Model)
    const view = defineView<Model, Message>(program.view)
    const inspectModel = (model: Model) => {
      const bySchema =
        inspections.get(program.Message) ??
        new Map<
          unknown,
          Map<unknown, ReturnType<typeof inspect<unknown, Message>>>
        >()
      const byView =
        bySchema.get(program.view) ??
        new Map<unknown, ReturnType<typeof inspect<unknown, Message>>>()
      inspections.set(program.Message, bySchema)
      bySchema.set(program.view, byView)
      const key = identity.of(model, `${program.name}.model`)
      const known = byView.get(key)
      if (known !== undefined) {
        return known
      }
      const result = inspect(
        program.view,
        model,
        environment.inputs ?? [],
        message => {
          if (!isMessage(message)) {
            throw new Error(`${program.name}: view emitted an invalid Message.`)
          }
          return encodeMessage(message)
        },
      )
      byView.set(key, result)
      return result
    }
    const prepare = (
      model: Model,
      pending: Update.Commands<Message>,
      input: Input,
      context: ReadonlyArray<Decision>,
      issued: Update.Commands<Message>,
    ): Prepared<Model, Message, Input> => {
      identity.of(model, `${program.name}.model`)
      if (!isModel(model)) {
        throw new InvalidModelError(
          `${program.name}: start or update returned an invalid Model.`,
        )
      }
      freezeCommands(pending, `${program.name}.pending`)
      freezeCommands(issued, `${program.name}.issued`)
      const pendingDescription = describeCommands(pending)
      identity.of(input, `${program.name}.input`)
      identity.of(pendingDescription, `${program.name}.pending`)
      const key = identity.of([context, input, model, pendingDescription])
      const known = nodes.get(key)
      if (known !== undefined) {
        return {
          node: known,
          issued: describeCommands(issued),
          issuedCommands: issued,
        }
      }
      const inspection = inspectModel(model)
      const id = `${prefix}${nodes.size + 1}`
      const node: Node<Model, Message, Input> = {
        id,
        key,
        model,
        pending,
        input,
        context,
        interactions:
          environment.inputs === undefined
            ? {}
            : Record.fromIterableWith(
                inspection.interactions,
                ({ key, message }) => [key, message],
              ),
        evidence: {
          id,
          input,
          model,
          pending: pendingDescription,
          observation: observationOf(inspection, pendingDescription),
        },
      }
      return { node, issued: describeCommands(issued), issuedCommands: issued }
    }
    const start = (input: Input, context: ReadonlyArray<Decision>) => {
      identity.of(input, `${program.name}.input`)
      const started = program.start(input)
      return prepare(
        started.model,
        started.commands ?? [],
        input,
        context,
        started.commands ?? [],
      )
    }
    const event = (
      node: Node<Model, Message, Input>,
      outcome: Outcome<Transition<Message>>,
    ): Event<Message> => {
      const transition = outcome.value
      if (!isMessage(transition.message)) {
        throw new Error(`${program.name}: next returned an invalid Message.`)
      }
      const message = encodeMessage(transition.message)
      if (transition.kind === 'Move') {
        const key = canonical(['Move', message])
        return {
          transition,
          evidence: {
            kind: 'Move',
            key,
            message,
            decisions: outcome.decisions,
            label:
              inspectModel(node.model).interactions.find(
                action => action.key === key,
              )?.label ?? messageLabel(message),
          },
        }
      }
      const { index, command } = transition.request
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        node.pending[index] !== command
      ) {
        throw new Error(
          `${program.name}: answer must select a pending Command from this state.`,
        )
      }
      const selectedKey = commandKey(command)
      const occurrence = Array.filter(
        node.pending.slice(0, index),
        pending => commandKey(pending) === selectedKey,
      ).length
      const description = { name: command.name, args: command.args ?? {} }
      return {
        transition,
        evidence: {
          kind: 'Answer',
          key: canonical(['Answer', selectedKey, occurrence, message]),
          label: `${command.name} #${occurrence + 1}: ${messageLabel(message)}`,
          message,
          decisions: outcome.decisions,
          request: { command: description, occurrence, index },
        },
      }
    }
    const apply = (
      node: Node<Model, Message, Input>,
      selected: Event<Message>,
    ) => {
      const transition = selected.transition
      const updated = program.update(node.model, transition.message)
      return prepare(
        updated.model,
        Array.appendAll(
          remaining(node.pending, transition),
          updated.commands ?? [],
        ),
        node.input,
        node.context,
        updated.commands ?? [],
      )
    }
    const next = (
      node: Node<Model, Message, Input>,
    ): (() => Choices<Transition<Message>>) | undefined => {
      const choices = environment.next
      return choices === undefined
        ? undefined
        : () =>
            choices({
              model: node.model,
              pending: node.pending,
              input: node.input,
              interactions: node.interactions,
            })
    }
    const render = <ParentMessage>(
      execution: Execution | undefined,
      slot: string,
      h: HtmlBuilder<ParentMessage>,
      toParentMessage: (message: unknown) => ParentMessage,
    ): Html => {
      if (execution === undefined) {
        return h.empty
      }
      identity.of(execution.model, `${program.name}.model`)
      if (!isModel(execution.model)) {
        throw new Error(
          `${program.name}: comparison preview has an invalid Model.`,
        )
      }
      return h.submodel({
        slotId: slot,
        model: execution.model,
        view,
        toParentMessage,
      })
    }
    const sameEvidence = (
      actual: Execution,
      expected: Execution | undefined,
    ): boolean => {
      if (expected === undefined) {
        return false
      }
      identity.of(actual.model, `${program.name}.model`)
      identity.of(expected.model, `${program.name}.model`)
      return (
        isModel(actual.model) &&
        isModel(expected.model) &&
        canonical(actual.input) === canonical(expected.input) &&
        canonical(actual.model) === canonical(expected.model) &&
        canonical(encodeModel(actual.model)) ===
          canonical(encodeModel(expected.model)) &&
        canonical(actual.pending) === canonical(expected.pending) &&
        canonical(actual.observation) === canonical(expected.observation)
      )
    }
    return { nodes, start, event, apply, next, render, sameEvidence }
  }
  const beforeRuntime = makeRuntime(options.before, 'B')
  const afterRuntime = makeRuntime(options.after, 'A')
  const pairs = new Map<
    unknown,
    Pair<BeforeModel, AfterModel, Message, Input>
  >()
  const queue: Array<Pair<BeforeModel, AfterModel, Message, Input>> = []
  const failures: Array<PropertyFailure> = []
  const grouped = new Map<
    string,
    {
      id: string
      kind: FindingKind
      title: string
      description: string
      before: unknown
      after: unknown
      examples: Array<ComparisonExample>
      shortest: ComparisonExample
    }
  >()
  const work = {
    limits: normalizedLimits(options.limits),
    queueIndex: 0,
    examples: 0,
    starts: 0,
    beforeTransitions: 0,
    afterTransitions: 0,
    enumerationWork: 0,
    joinOperations: 0,
    startsComplete: false,
  }
  const transitions = () =>
    work.starts + work.beforeTransitions + work.afterTransitions
  const stopped: { status: ComparisonStatus } = { status: 'running' }
  const starts = enumerate(environment.starts)
  const startBuffer: {
    value:
      | Readonly<{
          outcome: Outcome<Input>
          before: Prepared<BeforeModel, Message, Input>
          after: Prepared<AfterModel, Message, Input>
        }>
      | undefined
  } = { value: undefined }

  const example = (pair: string, trace: ComparisonTrace): ComparisonExample => {
    work.examples += 1
    const frame = trace.at(-1)
    return {
      id: `E${work.examples}`,
      pair,
      depth: trace.length - 1,
      trace,
      before: frame?.before,
      after: frame?.after,
    }
  }
  const record = (
    key: unknown,
    kind: FindingKind,
    title: string,
    description: string,
    before: unknown,
    after: unknown,
    evidence: ComparisonExample,
  ) => {
    const encoded = canonical([kind, key])
    const known = grouped.get(encoded)
    if (known !== undefined) {
      if (!known.examples.includes(evidence)) {
        known.examples.push(evidence)
      }
      if (evidence.depth < known.shortest.depth) {
        known.shortest = evidence
      }
      return
    }
    grouped.set(encoded, {
      id: `F${grouped.size + 1}`,
      kind,
      title,
      description,
      before,
      after,
      examples: [evidence],
      shortest: evidence,
    })
  }
  const observe = (evidence: ComparisonExample) => {
    const before = evidence.before?.observation
    const after = evidence.after?.observation
    if (before === undefined || after === undefined) {
      return
    }
    const key = canonical([before.screen, after.screen])
    const deltas = screenDeltas.get(key) ?? changes(before.screen, after.screen)
    screenDeltas.set(key, deltas)
    Array.forEach(deltas, change => {
      const title =
        typeof change.before === 'string' && typeof change.after === 'string'
          ? `Content changed: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`
          : 'Rendered content changed'
      record(
        change,
        'content',
        title,
        typeof change.before === 'string' && typeof change.after === 'string'
          ? 'The rendered text changed.'
          : 'The rendered structure changed.',
        change.before,
        change.after,
        evidence,
      )
    })
    const beforeBindings = actionsByLabel(before.actions)
    const afterBindings = actionsByLabel(after.actions)
    Array.forEach(before.actions, (action, index) => {
      const previous = beforeBindings.get(action.label) ?? []
      const current = afterBindings.get(action.label) ?? []
      const stableLabel = previous.length === 1 && current.length === 1
      // Identical markup also lets us identify repeated labels by position.
      const counterpart = stableLabel
        ? current[0]
        : deltas.length === 0 &&
            before.actions.length === after.actions.length &&
            after.actions[index]?.label === action.label
          ? after.actions[index]
          : undefined
      if (counterpart === undefined || action.key === counterpart.key) {
        return
      }
      const control = stableLabel
        ? actionLabel(action.label)
        : `${actionLabel(action.label)} #${index + 1}`
      record(
        [control, action.key, counterpart.key],
        'action-changed',
        `Action ${JSON.stringify(control)} changed Message`,
        'The same supported control now emits a different Message.',
        action,
        counterpart,
        evidence,
      )
    })
    Array.forEach(before.actions, action => {
      if (!after.actions.some(candidate => candidate.key === action.key)) {
        record(
          action.key,
          'action-removed',
          `Action ${JSON.stringify(actionLabel(action.label))} removed`,
          'This supported interaction is present before and absent after.',
          action,
          undefined,
          evidence,
        )
      }
    })
    Array.forEach(after.actions, action => {
      if (!before.actions.some(candidate => candidate.key === action.key)) {
        record(
          action.key,
          'action-added',
          `Action ${JSON.stringify(actionLabel(action.label))} added`,
          'This supported interaction is absent before and present after.',
          undefined,
          action,
          evidence,
        )
      }
    })
    if (commandsKey(before.pending) !== commandsKey(after.pending)) {
      const difference = commandDifference(before.pending, after.pending)
      record(
        difference,
        'pending',
        'Pending Commands changed',
        'Command names, arguments, or the number of pending occurrences differ.',
        difference.before,
        difference.after,
        evidence,
      )
    }
  }
  const issued = (evidence: ComparisonExample) => {
    const frame = evidence.trace.at(-1)
    if (
      frame !== undefined &&
      commandsKey(frame.beforeIssued) !== commandsKey(frame.afterIssued)
    ) {
      const difference = commandDifference(
        frame.beforeIssued,
        frame.afterIssued,
      )
      record(
        difference,
        'commands',
        'Issued Commands changed',
        'This step creates different Commands or Command arguments.',
        difference.before,
        difference.after,
        evidence,
      )
    }
  }
  const checkProperties = (
    evidence: ComparisonExample,
    before: Node<BeforeModel, Message, Input> | undefined,
    after: Node<AfterModel, Message, Input> | undefined,
    previous?: Pair<BeforeModel, AfterModel, Message, Input>,
    beforeEvent?: Event<Message>,
    afterEvent?: Event<Message>,
    beforeIssued: Update.Commands<Message> = [],
    afterIssued: Update.Commands<Message> = [],
  ) => {
    const check = (
      property: Property<BeforeModel | AfterModel, Message>,
      kind: 'state' | 'transition',
      beforePassed: boolean | undefined,
      afterPassed: boolean | undefined,
    ) => {
      if (beforePassed === false) {
        failures.push({
          propertyId: property.id,
          property: property.name,
          side: 'before',
          kind,
          example: evidence,
        })
      }
      if (afterPassed === false) {
        failures.push({
          propertyId: property.id,
          property: property.name,
          side: 'after',
          kind,
          example: evidence,
        })
      }
      if (
        beforePassed !== afterPassed &&
        (beforePassed === false || afterPassed === false)
      ) {
        const side = afterPassed === false ? 'after' : 'before'
        record(
          [property.id, kind, beforePassed, afterPassed],
          'property',
          `Property failed ${side}: ${property.name}`,
          'Property results describe these executions; they do not establish a global pass for either version.',
          beforePassed,
          afterPassed,
          evidence,
        )
      }
    }
    Array.forEach(properties, property => {
      if (property.state !== undefined) {
        check(
          property,
          'state',
          before === undefined || property.stateApplies?.(before) === false
            ? undefined
            : property.state(before),
          after === undefined || property.stateApplies?.(after) === false
            ? undefined
            : property.state(after),
        )
      }
      const predicate = property.transition
      if (predicate !== undefined && previous !== undefined) {
        const evaluate = (
          source: Node<BeforeModel | AfterModel, Message, Input>,
          target: Node<BeforeModel | AfterModel, Message, Input> | undefined,
          event: Event<Message> | undefined,
          issued: Update.Commands<Message>,
        ) => {
          if (target === undefined || event === undefined) {
            return undefined
          }
          const step = transitionEvidence(
            source.pending,
            event.transition,
            issued,
          )
          return property.transitionApplies?.(
            source,
            event.transition.message,
            target,
            step,
          ) === false
            ? undefined
            : predicate(source, event.transition.message, target, step)
        }
        check(
          property,
          'transition',
          evaluate(previous.before, before, beforeEvent, beforeIssued),
          evaluate(previous.after, after, afterEvent, afterIssued),
        )
      }
    })
  }
  const pairKey = (
    before: Node<BeforeModel, Message, Input>,
    after: Node<AfterModel, Message, Input>,
  ) => identity.of([before.key, after.key])
  const canStore = (
    before: Node<BeforeModel, Message, Input> | undefined,
    after: Node<AfterModel, Message, Input> | undefined,
  ): boolean => {
    if (
      (before !== undefined &&
        !beforeRuntime.nodes.has(before.key) &&
        beforeRuntime.nodes.size >= work.limits.states) ||
      (after !== undefined &&
        !afterRuntime.nodes.has(after.key) &&
        afterRuntime.nodes.size >= work.limits.states)
    ) {
      stopped.status = 'state-limit'
      return false
    }
    if (
      before !== undefined &&
      after !== undefined &&
      !pairs.has(pairKey(before, after)) &&
      pairs.size >= work.limits.pairs
    ) {
      stopped.status = 'pair-limit'
      return false
    }
    return true
  }
  const arrive = (
    before: Node<BeforeModel, Message, Input>,
    after: Node<AfterModel, Message, Input>,
    trace: ComparisonTrace,
  ): Pair<BeforeModel, AfterModel, Message, Input> => {
    beforeRuntime.nodes.set(before.key, before)
    afterRuntime.nodes.set(after.key, after)
    const key = pairKey(before, after)
    const known = pairs.get(key)
    if (known !== undefined) {
      return known
    }
    const pair: Pair<BeforeModel, AfterModel, Message, Input> = {
      id: `P${pairs.size + 1}`,
      before,
      after,
      trace,
      depth: trace.length - 1,
      beforeEvents: enumeration(),
      afterEvents: enumeration(),
      ready: [],
      nextReady: 0,
      reconciled: false,
      turn: 'before',
      buffered: undefined,
    }
    pairs.set(key, pair)
    queue.push(pair)
    return pair
  }
  const initialize = (): boolean => {
    if (startBuffer.value === undefined) {
      if (transitions() >= work.limits.transitions) {
        stopped.status = 'transition-limit'
        return false
      }
      if (work.enumerationWork >= work.limits.enumerationWork) {
        stopped.status = 'enumeration-limit'
        return false
      }
      const step = starts.next()
      work.enumerationWork += 1
      if (step.done) {
        work.startsComplete = true
        return true
      }
      if (step.value.kind === 'work') {
        return true
      }
      const outcome = step.value.outcome
      work.starts += 1
      startBuffer.value = {
        outcome,
        before: beforeRuntime.start(outcome.value, outcome.decisions),
        after: afterRuntime.start(outcome.value, outcome.decisions),
      }
    }
    const buffered = startBuffer.value
    if (!canStore(buffered.before.node, buffered.after.node)) {
      return false
    }
    const trace: ComparisonTrace = [
      {
        kind: 'Start',
        label:
          buffered.outcome.decisions
            .map(decision => decision.option)
            .join(' → ') || 'Start',
        startDecisions: buffered.outcome.decisions,
        before: buffered.before.node.evidence,
        after: buffered.after.node.evidence,
        beforeIssued: buffered.before.issued,
        afterIssued: buffered.after.issued,
      },
    ]
    const pair = arrive(buffered.before.node, buffered.after.node, trace)
    const evidence = example(pair.id, trace)
    observe(evidence)
    issued(evidence)
    checkProperties(evidence, buffered.before.node, buffered.after.node)
    startBuffer.value = undefined
    return true
  }
  const readyEvent = (
    pair: Pair<BeforeModel, AfterModel, Message, Input>,
  ): string | undefined => {
    // A matched event is queued once, as soon as the second side offers it.
    // Only after both iterators finish can we queue unmatched alternatives.
    if (
      !pair.reconciled &&
      pair.beforeEvents.status === 'complete' &&
      pair.afterEvents.status === 'complete'
    ) {
      pair.reconciled = true
      for (const key of pair.beforeEvents.events.keys()) {
        work.joinOperations += 1
        if (!pair.afterEvents.events.has(key)) {
          pair.ready.push(key)
        }
      }
      for (const key of pair.afterEvents.events.keys()) {
        work.joinOperations += 1
        if (!pair.beforeEvents.events.has(key)) {
          pair.ready.push(key)
        }
      }
    }
    return pair.ready[pair.nextReady]
  }
  const applyReady = (
    pair: Pair<BeforeModel, AfterModel, Message, Input>,
    key: string,
  ): boolean => {
    if (pair.buffered === undefined) {
      work.joinOperations += 2
      const beforeEvent = pair.beforeEvents.events.get(key)
      const afterEvent = pair.afterEvents.events.get(key)
      pair.buffered = {
        key,
        beforeEvent,
        afterEvent,
        before:
          beforeEvent === undefined
            ? undefined
            : beforeRuntime.apply(pair.before, beforeEvent),
        after:
          afterEvent === undefined
            ? undefined
            : afterRuntime.apply(pair.after, afterEvent),
      }
    }
    const buffered = pair.buffered
    if (!canStore(buffered.before?.node, buffered.after?.node)) {
      return false
    }
    const frame: ComparisonStep = {
      kind: 'Transition',
      label:
        buffered.beforeEvent?.evidence.label ??
        buffered.afterEvent?.evidence.label ??
        'Event',
      startDecisions: [],
      before: buffered.before?.node.evidence,
      after: buffered.after?.node.evidence,
      beforeEvent: buffered.beforeEvent?.evidence,
      afterEvent: buffered.afterEvent?.evidence,
      beforeIssued: buffered.before?.issued ?? [],
      afterIssued: buffered.after?.issued ?? [],
    }
    const trace = Array.append(pair.trace, frame)
    const target =
      buffered.before !== undefined && buffered.after !== undefined
        ? arrive(buffered.before.node, buffered.after.node, trace)
        : pair
    if (buffered.before !== undefined && buffered.after === undefined) {
      beforeRuntime.nodes.set(buffered.before.node.key, buffered.before.node)
    }
    if (buffered.after !== undefined && buffered.before === undefined) {
      afterRuntime.nodes.set(buffered.after.node.key, buffered.after.node)
    }
    const evidence = example(target.id, trace)
    observe(evidence)
    issued(evidence)
    checkProperties(
      evidence,
      buffered.before?.node,
      buffered.after?.node,
      pair,
      buffered.beforeEvent,
      buffered.afterEvent,
      buffered.before?.issuedCommands,
      buffered.after?.issuedCommands,
    )
    if (
      buffered.beforeEvent === undefined &&
      buffered.afterEvent !== undefined
    ) {
      const selected = buffered.afterEvent.evidence
      const action = pair.after.evidence.observation.actions.find(
        action => action.key === key,
      )
      record(
        key,
        action === undefined ? 'event-added' : 'action-added',
        action === undefined
          ? `Event ${JSON.stringify(selected.label)} added`
          : `Action ${JSON.stringify(actionLabel(action.label))} added`,
        'Only the after version offers this event. Its real successor is recorded; this branch stops here.',
        undefined,
        selected,
        evidence,
      )
    }
    if (
      buffered.afterEvent === undefined &&
      buffered.beforeEvent !== undefined
    ) {
      const selected = buffered.beforeEvent.evidence
      const action = pair.before.evidence.observation.actions.find(
        action => action.key === key,
      )
      record(
        key,
        action === undefined ? 'event-removed' : 'action-removed',
        action === undefined
          ? `Event ${JSON.stringify(selected.label)} removed`
          : `Action ${JSON.stringify(actionLabel(action.label))} removed`,
        'Only the before version offers this event. Its real successor is recorded; this branch stops here.',
        selected,
        undefined,
        evidence,
      )
    }
    pair.nextReady += 1
    pair.buffered = undefined
    return true
  }
  const consume = <Model extends BeforeModel | AfterModel>(
    runtime: ReturnType<typeof makeRuntime<Model>>,
    node: Node<Model, Message, Input>,
    cursor: Enumeration<Message>,
    counterpart: Enumeration<Message>,
    ready: Array<string>,
    side: ComparisonSide,
    completed: () => void,
  ): boolean => {
    if (cursor.status === 'unseen') {
      const next = runtime.next(node)
      if (next === undefined) {
        cursor.status = 'complete'
        completed()
        return true
      }
      cursor.iterator = enumerate(next)
      cursor.status = 'partial'
    }
    if (transitions() >= work.limits.transitions) {
      stopped.status = 'transition-limit'
      return false
    }
    if (work.enumerationWork >= work.limits.enumerationWork) {
      stopped.status = 'enumeration-limit'
      return false
    }
    const result = cursor.iterator?.next()
    work.enumerationWork += 1
    if (result === undefined || result.done) {
      cursor.status = 'complete'
      completed()
      return true
    }
    if (result.value.kind === 'work') {
      return true
    }
    completed()
    if (side === 'before') {
      work.beforeTransitions += 1
    } else {
      work.afterTransitions += 1
    }
    const selected = runtime.event(node, result.value.outcome)
    work.joinOperations += 1
    if (cursor.events.has(selected.evidence.key)) {
      throw new Error(
        `Duplicate comparison event key in ${side} ${node.id}; environment alternatives must identify each semantic event unambiguously.`,
      )
    }
    cursor.events.set(selected.evidence.key, selected)
    work.joinOperations += 1
    if (counterpart.events.has(selected.evidence.key)) {
      ready.push(selected.evidence.key)
    }
    return true
  }
  const advance = (): boolean => {
    if (!work.startsComplete) {
      return initialize()
    }
    const pair = queue[work.queueIndex]
    if (pair === undefined) {
      stopped.status = 'complete'
      return false
    }
    if (environment.next === undefined) {
      pair.beforeEvents.status = 'complete'
      pair.afterEvents.status = 'complete'
    }
    const key = pair.buffered?.key ?? readyEvent(pair)
    if (key !== undefined) {
      return applyReady(pair, key)
    }
    if (
      pair.beforeEvents.status === 'complete' &&
      pair.afterEvents.status === 'complete'
    ) {
      work.queueIndex += 1
      return true
    }
    if (pair.depth >= work.limits.depth) {
      stopped.status = 'depth-limit'
      return false
    }
    const side =
      (pair.turn === 'before' && pair.beforeEvents.status !== 'complete') ||
      pair.afterEvents.status === 'complete'
        ? 'before'
        : 'after'
    const completed = () => {
      pair.turn = side === 'before' ? 'after' : 'before'
    }
    return side === 'before'
      ? consume(
          beforeRuntime,
          pair.before,
          pair.beforeEvents,
          pair.afterEvents,
          pair.ready,
          side,
          completed,
        )
      : consume(
          afterRuntime,
          pair.after,
          pair.afterEvents,
          pair.beforeEvents,
          pair.ready,
          side,
          completed,
        )
  }
  const run = () => {
    stopped.status = 'complete'
    const progress = { running: true }
    while (progress.running) {
      progress.running = advance()
    }
  }
  const selectedReplaySteps = function* (
    trace: ComparisonTrace,
  ): Generator<void, ComparisonTrace> {
    assertOpen()
    const first = trace[0]
    if (first === undefined || first.kind !== 'Start') {
      throw new ReplayDivergenceError(
        'hop-kind',
        'A comparison trace must begin with a shared start.',
      )
    }
    const replayCache: InspectionCache = new Map()
    const replayBefore = makeRuntime(options.before, 'RB', replayCache)
    const replayAfter = makeRuntime(options.after, 'RA', replayCache)
    const input = yield* replayChoicesSteps(
      environment.starts,
      first.startDecisions,
    )
    const before = replayBefore.start(input, first.startDecisions)
    const after = replayAfter.start(input, first.startDecisions)
    replayBefore.nodes.set(before.node.key, before.node)
    replayAfter.nodes.set(after.node.key, after.node)
    const frames: Array<ComparisonStep> = [
      {
        kind: 'Start',
        label: first.label,
        startDecisions: first.startDecisions,
        before: before.node.evidence,
        after: after.node.evidence,
        beforeIssued: before.issued,
        afterIssued: after.issued,
      },
    ]
    const current: {
      before: Node<BeforeModel, Message, Input> | undefined
      after: Node<AfterModel, Message, Input> | undefined
    } = { before: before.node, after: after.node }
    const replayEvent = function* <Model extends BeforeModel | AfterModel>(
      runtime: ReturnType<typeof makeRuntime<Model>>,
      node: Node<Model, Message, Input> | undefined,
      event: ComparisonEvent | undefined,
    ): Generator<void, Prepared<Model, Message, Input> | undefined> {
      if (event === undefined) {
        return undefined
      }
      if (node === undefined) {
        throw new ReplayDivergenceError(
          'hop-kind',
          'Comparison replay cannot continue an unmatched side.',
        )
      }
      const next = runtime.next(node)
      if (next === undefined) {
        throw new ReplayDivergenceError(
          'missing-event',
          'Comparison replay found no environment events.',
        )
      }
      const transition = yield* replayChoicesSteps(next, event.decisions)
      const selected = runtime.event(node, {
        decisions: event.decisions,
        value: transition,
      })
      if (
        selected.evidence.key !== event.key ||
        canonical(selected.evidence.message) !== canonical(event.message)
      ) {
        throw new ReplayDivergenceError(
          'message',
          'Comparison replay event changed; environment choices must be deterministic.',
        )
      }
      const replayed = runtime.apply(node, selected)
      runtime.nodes.set(replayed.node.key, replayed.node)
      return replayed
    }
    const verifyMissing = function* <Model extends BeforeModel | AfterModel>(
      runtime: ReturnType<typeof makeRuntime<Model>>,
      node: Node<Model, Message, Input> | undefined,
      offered: ComparisonEvent,
    ): Generator<void, void> {
      if (node === undefined) {
        throw new ReplayDivergenceError(
          'missing-event',
          'Comparison replay cannot verify an unmatched side.',
        )
      }
      const next = runtime.next(node)
      if (next === undefined) {
        return
      }
      const count = { examined: 0 }
      for (const checkpoint of enumerate(next)) {
        yield
        if (checkpoint.kind === 'work') {
          continue
        }
        const candidate = checkpoint.outcome
        if (count.examined >= work.limits.transitions) {
          throw new ReplayDivergenceError(
            'missing-event',
            'Comparison replay cannot verify a missing event within its transition limit.',
          )
        }
        count.examined += 1
        if (runtime.event(node, candidate).evidence.key === offered.key) {
          throw new ReplayDivergenceError(
            'missing-event',
            'Comparison replay diverged: a previously missing event is now available.',
          )
        }
      }
    }
    for (const [index, frame] of trace.slice(1).entries()) {
      yield
      if (frame.kind !== 'Transition') {
        throw new ReplayDivergenceError(
          'hop-kind',
          'Comparison replay found an unexpected starting frame.',
        )
      }
      if (frame.beforeEvent !== undefined && frame.afterEvent === undefined) {
        if (index !== trace.length - 2) {
          throw new ReplayDivergenceError(
            'hop-kind',
            'Comparison replay requires unmatched events to be terminal.',
          )
        }
        yield* verifyMissing(replayAfter, current.after, frame.beforeEvent)
      }
      if (frame.afterEvent !== undefined && frame.beforeEvent === undefined) {
        if (index !== trace.length - 2) {
          throw new ReplayDivergenceError(
            'hop-kind',
            'Comparison replay requires unmatched events to be terminal.',
          )
        }
        yield* verifyMissing(replayBefore, current.before, frame.afterEvent)
      }
      const replayedBefore = yield* replayEvent(
        replayBefore,
        current.before,
        frame.beforeEvent,
      )
      const replayedAfter = yield* replayEvent(
        replayAfter,
        current.after,
        frame.afterEvent,
      )
      current.before = replayedBefore?.node
      current.after = replayedAfter?.node
      frames.push({
        kind: 'Transition',
        label: frame.label,
        startDecisions: [],
        before: replayedBefore?.node.evidence,
        after: replayedAfter?.node.evidence,
        beforeEvent: frame.beforeEvent,
        afterEvent: frame.afterEvent,
        beforeIssued: replayedBefore?.issued ?? [],
        afterIssued: replayedAfter?.issued ?? [],
      })
    }
    for (const [index, frame] of frames.entries()) {
      yield
      const expected = trace[index]
      if (
        expected === undefined ||
        (frame.before === undefined
          ? expected.before !== undefined
          : !replayBefore.sameEvidence(frame.before, expected.before)) ||
        (frame.after === undefined
          ? expected.after !== undefined
          : !replayAfter.sameEvidence(frame.after, expected.after)) ||
        canonical(frame.beforeIssued) !== canonical(expected.beforeIssued) ||
        canonical(frame.afterIssued) !== canonical(expected.afterIssued)
      ) {
        throw new ReplayDivergenceError(
          'evidence',
          'Comparison replay diverged from its recorded execution.',
        )
      }
    }
    return frames
  }
  const replaySteps = (
    trace: ComparisonTrace,
    options?: ReplayOptions,
  ): Generator<void, ComparisonTrace> =>
    boundedReplaySteps(selectedReplaySteps(trace), trace.length, {
      ...options,
      limits: {
        ...options?.limits,
        work: options?.limits?.work ?? work.limits.enumerationWork,
      },
    })
  const replay = (
    trace: ComparisonTrace,
    options?: ReplayOptions,
  ): ComparisonTrace => finishReplay(replaySteps(trace, options))
  const lifecycle = { disposed: false }
  const assertOpen = () => {
    if (lifecycle.disposed) {
      throw new Error('Comparison session is disposed.')
    }
  }
  const setLimits = (limits: ComparisonLimits) => {
    assertOpen()
    const next = normalizedLimits(limits)
    if (
      next.depth < work.limits.depth ||
      next.states < work.limits.states ||
      next.transitions < work.limits.transitions ||
      next.pairs < work.limits.pairs ||
      next.enumerationWork < work.limits.enumerationWork
    ) {
      throw new Error(
        'Comparison resume limits cannot decrease; start a fresh comparison for smaller limits.',
      )
    }
    work.limits = next
  }
  const comparison: Comparison = {
    name: `${options.before.name} → ${options.after.name}`,
    get status() {
      return stopped.status
    },
    get limits() {
      return work.limits
    },
    get counters() {
      return {
        starts: work.starts,
        beforeStates: beforeRuntime.nodes.size,
        afterStates: afterRuntime.nodes.size,
        pairs: pairs.size,
        transitions: transitions(),
        beforeTransitions: work.beforeTransitions,
        afterTransitions: work.afterTransitions,
        enumerationWork: work.enumerationWork,
        joinOperations: work.joinOperations,
      }
    },
    get findings() {
      return Array.fromIterable(grouped.values())
    },
    get propertyFailures() {
      return failures
    },
    get unfinishedWork() {
      const pending: Array<UnfinishedComparisonWork> = []
      if (!work.startsComplete) {
        pending.push({
          kind: 'starts',
          pair: '',
          depth: 0,
          before: work.starts === 0 ? 'unseen' : 'partial',
          after: work.starts === 0 ? 'unseen' : 'partial',
          beforeAlternatives: work.starts,
          afterAlternatives: work.starts,
        })
      }
      Array.forEach(queue.slice(work.queueIndex), pair => {
        pending.push({
          kind: 'pair',
          pair: pair.id,
          depth: pair.depth,
          before: pair.beforeEvents.status,
          after: pair.afterEvents.status,
          beforeAlternatives: pair.beforeEvents.events.size,
          afterAlternatives: pair.afterEvents.events.size,
        })
      })
      return pending
    },
    setLimits,
    advance: steps => {
      assertOpen()
      limit(steps, 'Chunk size')
      stopped.status = 'complete'
      const cursor = { remaining: steps }
      while (cursor.remaining > 0) {
        if (!advance()) {
          return true
        }
        cursor.remaining -= 1
      }
      stopped.status = 'running'
      return false
    },
    dispose: () => {
      if (lifecycle.disposed) {
        return
      }
      lifecycle.disposed = true
      const iterators = [
        starts,
        ...Array.flatMap(queue, pair => [
          pair.beforeEvents.iterator,
          pair.afterEvents.iterator,
        ]),
      ]
      const errors = Array.flatMap(iterators, iterator => {
        try {
          iterator?.return?.()
          return []
        } catch (error) {
          return [error]
        }
      })
      queue.length = 0
      pairs.clear()
      beforeRuntime.nodes.clear()
      afterRuntime.nodes.clear()
      grouped.clear()
      failures.length = 0
      inspectionCache.clear()
      screenDeltas.clear()
      startBuffer.value = undefined
      identity.clear()
      if (Array.isArrayNonEmpty(errors)) {
        throw new AggregateError(errors, 'Comparison cleanup failed.')
      }
    },
    resume: limits => {
      setLimits(limits)
      run()
      return comparison
    },
    replay,
    replaySteps,
    render: (side, example, traceIndex, slot, h, toParentMessage) => {
      const frame = example.trace[traceIndex]
      return side === 'before'
        ? beforeRuntime.render(frame?.before, slot, h, toParentMessage)
        : afterRuntime.render(frame?.after, slot, h, toParentMessage)
    },
  }
  return comparison
}
