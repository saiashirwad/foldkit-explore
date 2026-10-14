import { Array, Cause, Effect, Layer, Option, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import { type Html, type HtmlBuilder, createKeyedLazy } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  AnalysisStatus,
  ComparisonSnapshot,
  ExampleSnapshot,
} from './analysis-data'
import {
  CHUNK_SIZE,
  failureStatus,
  immutable,
  makeRunner,
} from './analysis-runner'
import { canonical } from './canonical'
import { type ComparisonOptions, createComparison } from './compare'
import type {
  Comparison,
  ComparisonExample,
  ComparisonFinding,
  ComparisonSide,
  ComparisonStep,
  ComparisonTrace,
  Execution,
} from './compare'
import { formatValue } from './display'

export type ComparisonCase = Readonly<{
  name: string
  create: (depth: number) => Comparison
  render: <ParentMessage>(
    side: ComparisonSide,
    execution: Execution | undefined,
    slot: string,
    h: HtmlBuilder<ParentMessage>,
    toParentMessage: (message: unknown) => ParentMessage,
  ) => Html
}>

export const makeComparisonCase = <
  BeforeModel,
  AfterModel,
  CaseMessage,
  Input = void,
>(
  name: string,
  options: ComparisonOptions<BeforeModel, AfterModel, CaseMessage, Input>,
): ComparisonCase => {
  const beforeView = defineView<BeforeModel, CaseMessage>(options.before.view)
  const afterView = defineView<AfterModel, CaseMessage>(options.after.view)
  return {
    name,
    create: depth =>
      createComparison({ ...options, limits: { ...options.limits, depth } }),
    render: (side, execution, slot, h, toParentMessage) => {
      if (execution === undefined) {
        return h.empty
      }
      if (
        side === 'before' &&
        Schema.is(options.before.Model)(execution.model)
      ) {
        return h.submodel({
          slotId: slot,
          model: execution.model,
          view: beforeView,
          toParentMessage,
        })
      }
      if (side === 'after' && Schema.is(options.after.Model)(execution.model)) {
        return h.submodel({
          slotId: slot,
          model: execution.model,
          view: afterView,
          toParentMessage,
        })
      }
      return h.p([], ['Invalid preview Model'])
    },
  }
}

// MODEL

const Replay = defineTaggedUnion({
  Idle: {},
  Running: { chunks: Schema.Number },
  Cancelled: {},
  Verified: {},
  Failed: { reason: Schema.String },
})

const Selection = defineTaggedUnion({
  Automatic: {},
  Finding: { id: Schema.String },
  Property: { id: Schema.String },
})

export const Model = Schema.Struct({
  scenario: Schema.String,
  depth: Schema.Number,
  selection: Selection,
  example: Schema.Number,
  step: Schema.Number,
  limit: Schema.Number,
  replay: Replay,
  runId: Schema.Number,
  analysis: AnalysisStatus,
  maybeSnapshot: Schema.Option(ComparisonSnapshot),
})
export type Model = typeof Model.Type

const PAGE = 24

export const initial = (): Model => ({
  scenario: '',
  depth: 8,
  selection: Selection.Automatic(),
  example: 0,
  step: -1,
  limit: PAGE,
  replay: Replay.Idle(),
  runId: 0,
  analysis: AnalysisStatus.Idle(),
  maybeSnapshot: Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SelectedComparison: { name: Schema.String },
  SelectedFinding: { finding: Schema.String },
  SelectedProperty: { property: Schema.String },
  SelectedExample: { example: Schema.Number },
  SelectedTraceStep: { step: Schema.Number },
  ClickedDeeper: {},
  ClickedShallower: {},
  ClickedShowMore: {},
  ClickedReset: {},
  ClickedReplay: {},
  ClickedCancel: {},
  CompletedAnalyzeComparison: {
    runId: Schema.Number,
    status: AnalysisStatus,
    maybeSnapshot: Schema.Option(ComparisonSnapshot),
  },
  CompletedReplayComparison: { runId: Schema.Number, status: AnalysisStatus },
  CompletedDisposeComparison: {
    runId: Schema.Number,
    maybeFailure: Schema.Option(AnalysisStatus),
  },
})
export type Message = typeof Message.Type

// VIEW

const lazyFinding = createKeyedLazy()
const sides: ReadonlyArray<ComparisonSide> = ['before', 'after']

type Evidence = Pick<
  ComparisonFinding,
  'id' | 'title' | 'before' | 'after' | 'examples' | 'shortest'
>

type PropertyGroup = Evidence &
  Readonly<{
    property: string
    kind: 'state' | 'transition'
    beforeCount: number
    afterCount: number
  }>

const propertyGroups = (
  comparison: ComparisonSnapshot,
): ReadonlyArray<PropertyGroup> => {
  const groups = new Map<
    string,
    {
      id: string
      property: string
      kind: 'state' | 'transition'
      beforeCount: number
      afterCount: number
      examples: Map<string, ComparisonExample>
      shortest: ComparisonExample
    }
  >()
  Array.forEach(comparison.propertyFailures, failure => {
    const id = canonical([failure.property, failure.kind])
    const group = groups.get(id) ?? {
      id,
      property: failure.property,
      kind: failure.kind,
      beforeCount: 0,
      afterCount: 0,
      examples: new Map<string, ComparisonExample>(),
      shortest: failure.example,
    }
    if (failure.side === 'before') {
      group.beforeCount += 1
    } else {
      group.afterCount += 1
    }
    group.examples.set(failure.example.id, failure.example)
    if (failure.example.depth < group.shortest.depth) {
      group.shortest = failure.example
    }
    groups.set(id, group)
  })
  return Array.map(Array.fromIterable(groups.values()), group => ({
    id: group.id,
    title: `Observed property failure: ${group.property}`,
    property: group.property,
    kind: group.kind,
    beforeCount: group.beforeCount,
    afterCount: group.afterCount,
    before: { recordedFailures: group.beforeCount },
    after: { recordedFailures: group.afterCount },
    examples: Array.fromIterable(group.examples.values()),
    shortest: group.shortest,
  }))
}

const statusLabel = (comparison: ComparisonSnapshot): string =>
  comparison.status === 'complete'
    ? 'complete'
    : `incomplete · ${comparison.status.replace('-limit', ' limit')}`

const json = (value: unknown): string =>
  value === undefined ? 'Not present' : formatValue(value, 2)

const previewView = (
  scenario: ComparisonCase,
  example: ComparisonExample,
  step: number,
  slot: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('comparison-previews')],
    Array.map(sides, side =>
      h.div(
        [h.Class('comparison-side')],
        [
          h.div(
            [h.Class(`comparison-side-label is-${side}`)],
            [side === 'before' ? 'Before' : 'After'],
          ),
          h.div(
            [h.Class('case-preview'), h.Inert(true)],
            [
              example.trace[step]?.[side] === undefined
                ? h.p(
                    [h.Class('comparison-missing')],
                    [
                      'This version does not offer the event. No successor exists.',
                    ],
                  )
                : scenario.render(
                    side,
                    example.trace[step]?.[side],
                    `${slot}-${side}`,
                    h,
                    () => Message.SelectedTraceStep({ step }),
                  ),
            ],
          ),
        ],
      ),
    ),
  )

const findingView = (
  scenario: ComparisonCase,
  finding: ComparisonFinding,
  isSelected: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('article')(
    finding.id,
    [h.Class(isSelected ? 'comparison-card is-selected' : 'comparison-card')],
    [
      h.header(
        [h.Class('comparison-card-head')],
        [
          h.div(
            [],
            [
              h.span(
                [h.Class('comparison-kind')],
                [finding.kind.replace('-', ' ')],
              ),
              h.h2([], [finding.title]),
            ],
          ),
          h.button(
            [
              h.Class('lab-quiet'),
              h.AriaPressed(isSelected ? 'true' : 'false'),
              h.OnClick(Message.SelectedFinding({ finding: finding.id })),
            ],
            ['Inspect'],
          ),
        ],
      ),
      h.p([h.Class('comparison-description')], [finding.description]),
      previewView(
        scenario,
        finding.shortest,
        finding.shortest.trace.length - 1,
        `card-${finding.id}`,
        h,
      ),
      h.footer(
        [h.Class('comparison-card-foot')],
        [
          `${finding.examples.length} ${finding.examples.length === 1 ? 'example' : 'examples'} · shortest trace ${finding.shortest.depth} ${finding.shortest.depth === 1 ? 'step' : 'steps'}`,
        ],
      ),
    ],
  )

const details = (
  title: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.details(
    [h.Class('inspector-details')],
    [h.summary([], [title]), h.div([h.Class('inspector-body')], children)],
  )

const evidenceView = (
  title: string,
  before: unknown,
  after: unknown,
  h: HtmlBuilder<Message>,
): Html =>
  details(
    title,
    Array.flatMap(sides, side => [
      h.h4([], [side === 'before' ? 'Before' : 'After']),
      h.pre([], [json(side === 'before' ? before : after)]),
    ]),
    h,
  )

const coverageView = (
  comparison: ComparisonSnapshot,
  h: HtmlBuilder<Message>,
): Html =>
  details(
    'Search coverage',
    [
      h.p(
        [],
        [
          `${comparison.counters.pairs} pairs; ${comparison.counters.beforeStates} before states; ${comparison.counters.afterStates} after states.`,
        ],
      ),
      h.p(
        [],
        [
          `${comparison.counters.transitions} enumerated alternatives, including ${comparison.counters.starts} starts; ${comparison.counters.enumerationWork} enumeration work. ${comparison.unfinishedWork.length} unfinished work items.`,
        ],
      ),
      h.p(
        [],
        [
          `Limits: depth ${comparison.limits.depth}; ${comparison.limits.states} states per version; ${comparison.limits.pairs} pairs; ${comparison.limits.transitions} alternatives; ${comparison.limits.enumerationWork} enumeration work.`,
        ],
      ),
      h.p(
        [],
        [
          'Rendered structure, supported controls and declared Commands are compared. CSS layout and unmodeled browser behavior are outside this comparison.',
        ],
      ),
    ],
    h,
  )

const propertiesView = (
  groups: ReadonlyArray<PropertyGroup>,
  selected: string | undefined,
  h: HtmlBuilder<Message>,
): Html =>
  Array.isReadonlyArrayEmpty(groups)
    ? h.empty
    : h.section(
        [
          h.Class('comparison-coverage'),
          h.AriaLabel('Observed property failures'),
        ],
        [
          h.strong([], ['Observed property failures']),
          h.p(
            [],
            [
              'These are recorded failures within this search. A failure shared by both versions is separate from their differences.',
            ],
          ),
          ...Array.map(groups, group =>
            h.button(
              [
                h.Class(group.id === selected ? 'row is-current' : 'row'),
                h.AriaLabel(
                  `Inspect property ${group.property} (${group.kind})`,
                ),
                h.AriaPressed(group.id === selected ? 'true' : 'false'),
                h.OnClick(Message.SelectedProperty({ property: group.id })),
              ],
              [
                h.span(
                  [h.Class('row-label')],
                  [`${group.property} · ${group.kind}`],
                ),
                h.span(
                  [h.Class('row-state')],
                  [`Before ${group.beforeCount} · After ${group.afterCount}`],
                ),
              ],
            ),
          ),
        ],
      )

const inspectorView = (
  model: Model,
  comparison: ComparisonSnapshot,
  scenario: ComparisonCase,
  finding: Evidence,
  example: ComparisonExample,
  isProperty: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const index =
    model.step < 0
      ? example.trace.length - 1
      : Math.min(model.step, example.trace.length - 1)
  const step: ComparisonStep | undefined = example.trace[index]
  const examples = new Set(Array.map(finding.examples, item => item.id))
  const failures = comparison.propertyFailures.filter(failure =>
    examples.has(failure.example.id),
  )
  return h.aside(
    [
      h.Class('inspector comparison-inspector'),
      h.AriaLabel(
        isProperty ? 'Selected property failure' : 'Selected difference',
      ),
    ],
    [
      h.header(
        [h.Class('inspector-head')],
        [
          h.div(
            [h.Class('inspector-title')],
            [
              h.strong([], [finding.title]),
              h.span([], [`${finding.examples.length} recorded examples`]),
            ],
          ),
        ],
      ),
      h.section(
        [h.Class('inspector-section')],
        [
          h.label(
            [h.Class('comparison-example')],
            [
              'Example',
              h.select(
                [
                  h.AriaLabel('Finding example'),
                  h.OnChange(value =>
                    Message.SelectedExample({ example: Number(value) }),
                  ),
                ],
                Array.map(finding.examples, (item, position) =>
                  h.option(
                    [
                      h.Value(`${position}`),
                      h.Selected(item.id === example.id),
                    ],
                    [`${position + 1} · ${item.depth} steps`],
                  ),
                ),
              ),
            ],
          ),
          h.p(
            [h.Class('inspector-hint')],
            [
              isProperty
                ? 'These examples record failures of the same property. Before and after observations remain separate.'
                : 'Examples share this measured difference. They may have different causes.',
            ],
          ),
        ],
      ),
      h.section(
        [h.Class('inspector-section is-trace')],
        [
          h.h4([], ['Replay the steps']),
          h.div(
            [h.Class('comparison-replay')],
            [
              h.button(
                [h.Class('lab-quiet'), h.OnClick(Message.ClickedReplay())],
                ['Replay fresh'],
              ),
              h.button(
                [
                  h.Class('lab-quiet'),
                  h.Disabled(index === 0),
                  h.OnClick(Message.SelectedTraceStep({ step: index - 1 })),
                ],
                ['Previous'],
              ),
              h.button(
                [
                  h.Class('lab-quiet'),
                  h.Disabled(index === example.trace.length - 1),
                  h.OnClick(Message.SelectedTraceStep({ step: index + 1 })),
                ],
                ['Next step'],
              ),
            ],
          ),
          Replay.match(model.replay, {
            Idle: () => h.empty,
            Running: ({ chunks }) =>
              h.p([h.Role('status')], [`Replaying · ${chunks} chunks`]),
            Cancelled: () => h.p([h.Role('status')], ['Replay cancelled.']),
            Verified: () =>
              h.p(
                [h.Class('inspector-hint'), h.Role('status')],
                ['Replayed both versions from fresh starting inputs.'],
              ),
            Failed: ({ reason }) =>
              h.p(
                [h.Class('comparison-error'), h.Role('alert')],
                [`Replay failed: ${reason}`],
              ),
          }),
          ...Array.map(example.trace, (frame, position) =>
            h.button(
              [
                h.Class(position === index ? 'row is-current' : 'row'),
                h.OnClick(Message.SelectedTraceStep({ step: position })),
                h.AriaCurrent(position === index ? 'step' : 'false'),
              ],
              [h.span([h.Class('row-label')], [frame.label])],
            ),
          ),
        ],
      ),
      h.section(
        [h.Class('inspector-section')],
        [
          h.h4(
            [],
            [index === 0 ? 'Starting executions' : `After step ${index}`],
          ),
          previewView(scenario, example, index, `inspector-${finding.id}`, h),
        ],
      ),
      evidenceView(
        isProperty ? 'Recorded property failures' : 'Measured difference',
        finding.before,
        finding.after,
        h,
      ),
      evidenceView('Messages', step?.beforeEvent, step?.afterEvent, h),
      evidenceView(
        'Pending Commands',
        step?.before?.pending,
        step?.after?.pending,
        h,
      ),
      evidenceView(
        'Newly issued Commands',
        step?.beforeIssued,
        step?.afterIssued,
        h,
      ),
      evidenceView('Models', step?.before?.model, step?.after?.model, h),
      details(
        'Affected executions',
        [
          h.pre(
            [],
            [
              json({
                before: example.before?.id,
                after: example.after?.id,
                pair: example.pair,
              }),
            ],
          ),
        ],
        h,
      ),
      details(
        'Properties',
        [
          h.p(
            [],
            [
              failures.length === 0
                ? 'No property failures recorded for these examples.'
                : `${failures.length} property failures recorded for these examples.`,
            ],
          ),
          ...Array.map(failures, failure =>
            h.p(
              [],
              [
                `${failure.side === 'before' ? 'Before' : 'After'}: ${failure.property} (${failure.kind})`,
              ],
            ),
          ),
          h.p(
            [],
            [
              'Before and after failures are separate observations within this search.',
            ],
          ),
        ],
        h,
      ),
    ],
  )
}

export const analysisLabel = (status: AnalysisStatus): string =>
  AnalysisStatus.match(status, {
    Idle: () => 'Not started',
    Running: ({ chunks }) => `Running · ${chunks} chunks`,
    Completed: () => 'Completed',
    Cancelled: () => 'Cancelled · not a successful check',
    InvalidModel: ({ reason }) => `Invalid model: ${reason}`,
    Defect: ({ reason }) => `Analysis failed: ${reason}`,
  })

// REVIEW

export const makeReview = (cases: ReadonlyArray<ComparisonCase>) => {
  type Resource = {
    comparison: Comparison
    iterator: Iterator<void, ComparisonTrace> | undefined
    dispose: () => void
  }
  const runner = makeRunner<Resource>()
  const scenarioOf = (model: Pick<Model, 'scenario'>) =>
    cases.find(item => item.name === model.scenario) ?? cases[0]
  const snapshot = (comparison: Comparison): ComparisonSnapshot => ({
    name: comparison.name,
    status: comparison.status,
    limits: { ...comparison.limits },
    counters: { ...comparison.counters },
    findings: comparison.findings.map(finding => ({
      ...finding,
      examples: [...finding.examples],
    })),
    propertyFailures: [...comparison.propertyFailures],
    unfinishedWork: [...comparison.unfinishedWork],
  })
  const create = (scenario: string, depth: number): Resource => {
    const registered = scenarioOf({ scenario })
    if (registered === undefined) {
      throw new Error('No comparison is registered.')
    }
    const comparison = registered.create(depth)
    const resource: Resource = {
      comparison,
      iterator: undefined,
      dispose: () => {
        try {
          resource.iterator?.return?.()
        } finally {
          comparison.dispose()
        }
      },
    }
    return resource
  }
  const AnalyzeComparison = Command.define('AnalyzeComparison', {
    args: {
      runId: Schema.Number,
      scenario: Schema.String,
      depth: Schema.Number,
      reset: Schema.Boolean,
      chunks: Schema.Number,
    },
    messages: [Message.CompletedAnalyzeComparison],
    execute: args =>
      runner
        .run(
          { runId: args.runId, key: args.scenario, reset: args.reset },
          () => create(args.scenario, args.depth),
          (resource, newRun) => {
            if (newRun) {
              resource.iterator?.return?.()
              resource.iterator = undefined
              resource.comparison.setLimits({
                ...resource.comparison.limits,
                depth: args.depth,
              })
            }
            const done = resource.comparison.advance(CHUNK_SIZE)
            return {
              done,
              value: done
                ? Option.some(snapshot(resource.comparison))
                : Option.none<ComparisonSnapshot>(),
            }
          },
          args.chunks,
        )
        .pipe(
          Effect.map(result =>
            immutable(
              Message.CompletedAnalyzeComparison({
                runId: args.runId,
                status: result.status,
                maybeSnapshot: Option.flatten(result.maybeValue),
              }),
            ),
          ),
          Effect.catchCause(cause =>
            Effect.exit(runner.cancel(args.runId)).pipe(
              Effect.as(
                Message.CompletedAnalyzeComparison({
                  runId: args.runId,
                  status: failureStatus(Cause.squash(cause)),
                  maybeSnapshot: Option.none(),
                }),
              ),
            ),
          ),
        ),
  })
  const ReplayComparison = Command.define('ReplayComparison', {
    args: {
      runId: Schema.Number,
      scenario: Schema.String,
      depth: Schema.Number,
      example: ExampleSnapshot,
      chunks: Schema.Number,
    },
    messages: [Message.CompletedReplayComparison],
    execute: args =>
      runner
        .run(
          { runId: args.runId, key: args.scenario, reset: false },
          () => create(args.scenario, args.depth),
          (resource, newRun) => {
            if (newRun) {
              resource.iterator?.return?.()
              resource.iterator = resource.comparison.replaySteps(
                args.example.trace,
              )
            }
            const iterator = resource.iterator
            if (iterator === undefined) {
              throw new Error('Replay was not initialized.')
            }
            const cursor = { remaining: CHUNK_SIZE, done: false }
            while (cursor.remaining > 0 && !cursor.done) {
              cursor.done = iterator.next().done === true
              cursor.remaining -= 1
            }
            return { done: cursor.done, value: {} }
          },
          args.chunks,
        )
        .pipe(
          Effect.map(result =>
            Message.CompletedReplayComparison({
              runId: args.runId,
              status: result.status,
            }),
          ),
          Effect.catchCause(cause =>
            Effect.exit(runner.cancel(args.runId)).pipe(
              Effect.as(
                Message.CompletedReplayComparison({
                  runId: args.runId,
                  status: failureStatus(Cause.squash(cause)),
                }),
              ),
            ),
          ),
        ),
  })
  const DisposeComparison = Command.define('DisposeComparison', {
    args: { runId: Schema.Number },
    messages: [Message.CompletedDisposeComparison],
    execute: ({ runId }) =>
      runner.cancel(runId).pipe(
        Effect.as(
          Message.CompletedDisposeComparison({
            runId,
            maybeFailure: Option.none(),
          }),
        ),
        Effect.catchCause(cause =>
          Effect.succeed(
            Message.CompletedDisposeComparison({
              runId,
              maybeFailure: Option.some(failureStatus(Cause.squash(cause))),
            }),
          ),
        ),
      ),
  })
  const selected = (model: Model, comparison: ComparisonSnapshot) => {
    const groups = propertyGroups(comparison)
    const requested = Selection.match<
      Readonly<{ finding: Evidence; isProperty: boolean }> | undefined
    >(model.selection, {
      Automatic: () => undefined,
      Finding: ({ id }) => {
        const finding = comparison.findings.find(item => item.id === id)
        return finding === undefined
          ? undefined
          : { finding, isProperty: false }
      },
      Property: ({ id }) => {
        const finding = groups.find(item => item.id === id)
        return finding === undefined ? undefined : { finding, isProperty: true }
      },
    })
    const first = comparison.findings[0] ?? groups[0]
    const choice =
      requested ??
      (first === undefined
        ? undefined
        : { finding: first, isProperty: comparison.findings[0] === undefined })
    return choice === undefined
      ? undefined
      : {
          finding: choice.finding,
          example:
            choice.finding.examples[model.example] ?? choice.finding.shortest,
          isProperty: choice.isProperty,
        }
  }
  const resetSelection = (model: Model): Model =>
    modifyFields(model, {
      selection: () => Selection.Automatic(),
      example: () => 0,
      step: () => -1,
      replay: () => Replay.Idle(),
    })

  const continueAnalysis = (
    model: Model,
    reset: boolean,
  ): Update.Return<Model, Message> => ({
    model,
    commands: [
      AnalyzeComparison({
        runId: model.runId,
        scenario: model.scenario,
        depth: model.depth,
        reset,
        chunks: model.analysis._tag === 'Running' ? model.analysis.chunks : 0,
      }),
    ],
  })
  const start = (
    model: Model,
    reset = false,
  ): Update.Return<Model, Message> => {
    const scenario = scenarioOf(model)
    if (scenario === undefined) {
      return { model }
    }
    return continueAnalysis(
      modifyFields(resetSelection(model), {
        scenario: () => scenario.name,
        runId: id => id + 1,
        analysis: () => AnalysisStatus.Running({ chunks: 0 }),
        maybeSnapshot: () => Option.none(),
      }),
      reset,
    )
  }
  const cancel = (model: Model): Update.Return<Model, Message> => {
    const cancelled = modifyFields(model, {
      runId: id => id + 1,
      analysis: () => AnalysisStatus.Cancelled(),
      replay: replay =>
        replay._tag === 'Running' ? Replay.Cancelled() : replay,
    })
    return {
      model: cancelled,
      commands: [DisposeComparison({ runId: cancelled.runId })],
    }
  }
  const changeSelection = (
    model: Model,
    change: (model: Model) => Model,
  ): Update.Return<Model, Message> => {
    const stopped = model.replay._tag === 'Running' ? cancel(model) : { model }
    return { ...stopped, model: change(resetSelection(stopped.model)) }
  }
  const update = (model: Model, message: Message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      SelectedComparison: ({ name }) =>
        start(
          modifyFields(model, { scenario: () => name, limit: () => PAGE }),
          true,
        ),
      SelectedFinding: ({ finding }) =>
        changeSelection(model, next =>
          modifyFields(next, {
            selection: () => Selection.Finding({ id: finding }),
          }),
        ),
      SelectedProperty: ({ property }) =>
        changeSelection(model, next =>
          modifyFields(next, {
            selection: () => Selection.Property({ id: property }),
          }),
        ),
      SelectedExample: ({ example }) =>
        changeSelection(model, next =>
          modifyFields(next, { example: () => Math.max(0, example) }),
        ),
      SelectedTraceStep: ({ step }) => ({
        model: modifyFields(model, { step: () => Math.max(0, step) }),
      }),
      ClickedDeeper: () =>
        start(
          modifyFields(model, { depth: depth => depth + 1, limit: () => PAGE }),
        ),
      ClickedShallower: () =>
        start(
          modifyFields(model, {
            depth: depth => Math.max(0, depth - 1),
            limit: () => PAGE,
          }),
          true,
        ),
      ClickedShowMore: () => ({
        model: modifyFields(model, { limit: limit => limit + PAGE }),
      }),
      ClickedReset: () =>
        start(
          modifyFields(initial(), {
            scenario: () => model.scenario,
            runId: () => model.runId,
          }),
          true,
        ),
      ClickedCancel: () => cancel(model),
      ClickedReplay: () =>
        Option.match(model.maybeSnapshot, {
          onNone: () => ({ model }),
          onSome: comparison => {
            const selection = selected(model, comparison)
            if (selection === undefined) {
              return { model }
            }
            const next = modifyFields(model, {
              runId: id => id + 1,
              replay: () => Replay.Running({ chunks: 0 }),
            })
            return {
              model: next,
              commands: [
                ReplayComparison({
                  runId: next.runId,
                  scenario: next.scenario,
                  depth: next.depth,
                  example: selection.example,
                  chunks: 0,
                }),
              ],
            }
          },
        }),
      CompletedAnalyzeComparison: ({ runId, status, maybeSnapshot }) => {
        if (runId !== model.runId || model.analysis._tag !== 'Running') {
          return { model }
        }
        const next = modifyFields(model, {
          analysis: () => status,
          maybeSnapshot: previous =>
            Option.orElse(maybeSnapshot, () => previous),
        })
        return status._tag === 'Running'
          ? continueAnalysis(next, false)
          : { model: next }
      },
      CompletedReplayComparison: ({ runId, status }) => {
        if (runId !== model.runId || model.replay._tag !== 'Running') {
          return { model }
        }
        const replay = AnalysisStatus.match(status, {
          Idle: () => Replay.Idle(),
          Running: ({ chunks }) => Replay.Running({ chunks }),
          Completed: () => Replay.Verified(),
          Cancelled: () => Replay.Cancelled(),
          InvalidModel: ({ reason }) => Replay.Failed({ reason }),
          Defect: ({ reason }) => Replay.Failed({ reason }),
        })
        const next = modifyFields(model, {
          replay: () => replay,
          step: previous => (status._tag === 'Completed' ? 0 : previous),
        })
        return replay._tag === 'Running'
          ? Option.match(next.maybeSnapshot, {
              onNone: () => ({ model: next }),
              onSome: comparison => {
                const selection = selected(next, comparison)
                return selection === undefined
                  ? { model: next }
                  : {
                      model: next,
                      commands: [
                        ReplayComparison({
                          runId,
                          scenario: next.scenario,
                          depth: next.depth,
                          example: selection.example,
                          chunks: replay.chunks,
                        }),
                      ],
                    }
              },
            })
          : { model: next }
      },
      CompletedDisposeComparison: ({ runId, maybeFailure }) => ({
        model:
          runId !== model.runId
            ? model
            : Option.match(maybeFailure, {
                onNone: () => model,
                onSome: status =>
                  modifyFields(model, { analysis: () => status }),
              }),
      }),
    })

  const view = defineView<Model, Message, Readonly<{ mode: () => Html }>>(
    (model, inputs, h) =>
      Option.match(model.maybeSnapshot, {
        onNone: () =>
          h.div(
            [h.Class('lab')],
            [
              h.header(
                [h.Class('lab-header')],
                [
                  inputs.mode(),
                  h.select(
                    [
                      h.AriaLabel('Comparison'),
                      h.Class('lab-program'),
                      h.OnChange(name => Message.SelectedComparison({ name })),
                    ],
                    Array.map(cases, (scenario, index) =>
                      h.option(
                        [
                          h.Value(scenario.name),
                          h.Selected(
                            scenario.name === model.scenario ||
                              (model.scenario === '' && index === 0),
                          ),
                        ],
                        [scenario.name],
                      ),
                    ),
                  ),
                  h.div(
                    [h.Class('lab-header-end')],
                    [
                      h.span(
                        [h.Class('lab-count'), h.Role('status')],
                        [
                          cases.length === 0
                            ? 'No comparisons are registered.'
                            : analysisLabel(model.analysis),
                        ],
                      ),
                      h.div(
                        [h.Class('lab-depth')],
                        [
                          h.span([], ['depth']),
                          h.button(
                            [
                              h.AriaLabel('Fewer comparison steps'),
                              h.Disabled(model.depth === 0),
                              h.OnClick(Message.ClickedShallower()),
                            ],
                            ['−'],
                          ),
                          h.output([], [`${model.depth}`]),
                          h.button(
                            [
                              h.AriaLabel('More comparison steps'),
                              h.OnClick(Message.ClickedDeeper()),
                            ],
                            ['+'],
                          ),
                        ],
                      ),
                      model.analysis._tag === 'Running'
                        ? h.button(
                            [
                              h.Class('lab-quiet'),
                              h.OnClick(Message.ClickedCancel()),
                            ],
                            ['Cancel'],
                          )
                        : h.empty,
                      h.button(
                        [
                          h.Class('lab-quiet'),
                          h.OnClick(Message.ClickedReset()),
                        ],
                        ['Reset'],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        onSome: comparison => {
          const selection = selected(model, comparison)
          const scenario = scenarioOf(model)
          if (scenario === undefined) {
            return h.empty
          }
          return h.div(
            [h.Class('lab')],
            [
              h.header(
                [h.Class('lab-header')],
                [
                  inputs.mode(),
                  h.select(
                    [
                      h.AriaLabel('Comparison'),
                      h.Class('lab-program'),
                      h.OnChange(name => Message.SelectedComparison({ name })),
                    ],
                    Array.map(cases, (scenario, index) =>
                      h.option(
                        [
                          h.Value(scenario.name),
                          h.Selected(
                            scenario.name === model.scenario ||
                              (model.scenario === '' && index === 0),
                          ),
                        ],
                        [scenario.name],
                      ),
                    ),
                  ),
                  h.div(
                    [h.Class('lab-header-end')],
                    [
                      h.span(
                        [h.Class('lab-count')],
                        [
                          `${comparison.findings.length} findings · ${comparison.counters.pairs} pairs · ${model.analysis._tag === 'Completed' ? statusLabel(comparison) : analysisLabel(model.analysis)}`,
                        ],
                      ),
                      h.div(
                        [h.Class('lab-depth')],
                        [
                          h.span([], ['depth']),
                          h.button(
                            [
                              h.AriaLabel('Fewer comparison steps'),
                              h.Disabled(model.depth === 0),
                              h.OnClick(Message.ClickedShallower()),
                            ],
                            ['−'],
                          ),
                          h.output([], [`${model.depth}`]),
                          h.button(
                            [
                              h.AriaLabel('More comparison steps'),
                              h.Disabled(comparison.status !== 'depth-limit'),
                              h.OnClick(Message.ClickedDeeper()),
                            ],
                            ['+'],
                          ),
                        ],
                      ),
                      model.analysis._tag === 'Running' ||
                      model.replay._tag === 'Running'
                        ? h.button(
                            [
                              h.Class('lab-quiet'),
                              h.OnClick(Message.ClickedCancel()),
                            ],
                            ['Cancel'],
                          )
                        : h.empty,
                      h.button(
                        [
                          h.Class('lab-quiet'),
                          h.OnClick(Message.ClickedReset()),
                        ],
                        ['Reset'],
                      ),
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class('comparison-coverage'), h.Role('status')],
                [
                  h.strong([], [`${comparison.name}. `]),
                  model.analysis._tag !== 'Completed'
                    ? analysisLabel(model.analysis)
                    : comparison.status === 'complete'
                      ? 'Complete within the declared environment.'
                      : `Search stopped at the ${comparison.status.replace('-limit', '')} limit. Unfinished alternatives remain unknown.`,
                ],
              ),
              h.div(
                [h.Class('comparison-coverage')],
                [coverageView(comparison, h)],
              ),
              propertiesView(
                propertyGroups(comparison),
                selection?.isProperty === true
                  ? selection.finding.id
                  : undefined,
                h,
              ),
              h.main(
                [h.Class('lab-workspace comparison-workspace')],
                [
                  h.section(
                    [h.Class('comparison-grid'), h.AriaLabel('Differences')],
                    [
                      ...Array.match(comparison.findings, {
                        onEmpty: () => [
                          h.div(
                            [h.Class('comparison-empty')],
                            [
                              h.h2([], ['No differences found']),
                              h.p(
                                [],
                                [
                                  'The versions agree within these starting inputs, event choices and search limits.',
                                ],
                              ),
                              h.p(
                                [],
                                [
                                  'This does not establish agreement for every input, browser or execution.',
                                ],
                              ),
                            ],
                          ),
                        ],
                        onNonEmpty: findings =>
                          Array.map(
                            Array.take(findings, model.limit),
                            finding =>
                              lazyFinding(finding.id, findingView, [
                                scenario,
                                finding,
                                selection?.isProperty === false &&
                                  finding.id === selection.finding.id,
                                h,
                              ]),
                          ),
                      }),
                      comparison.findings.length > model.limit
                        ? h.button(
                            [
                              h.Class('lab-more'),
                              h.OnClick(Message.ClickedShowMore()),
                            ],
                            ['Show more findings'],
                          )
                        : h.empty,
                    ],
                  ),
                  selection === undefined
                    ? h.empty
                    : inspectorView(
                        model,
                        comparison,
                        scenario,
                        selection.finding,
                        selection.example,
                        selection.isProperty,
                        h,
                      ),
                ],
              ),
            ],
          )
        },
      }),
  )
  return {
    Model,
    Message,
    update,
    view,
    start,
    cancel,
    dispose: runner.shutdown,
    resources: Layer.effectDiscard(Effect.addFinalizer(() => runner.shutdown)),
  }
}
