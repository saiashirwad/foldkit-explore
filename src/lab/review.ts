import { Array, Option, Schema } from 'effect'
import type { Update } from 'foldkit'
import { type Html, type HtmlBuilder, createKeyedLazy } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import { canonical } from './canonical'
import type {
  Comparison,
  ComparisonExample,
  ComparisonFinding,
  ComparisonSide,
  ComparisonStep,
} from './compare'
import { formatValue } from './display'

export type ComparisonCase = Readonly<{
  name: string
  run: (depth: number) => Comparison
}>

// MODEL

const Replay = defineTaggedUnion({
  Idle: {},
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
  comparison: Comparison,
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

const statusLabel = (comparison: Comparison): string =>
  comparison.status === 'complete'
    ? 'complete'
    : `incomplete · ${comparison.status.replace('-limit', ' limit')}`

const json = (value: unknown): string =>
  value === undefined ? 'Not present' : formatValue(value, 2)

const previewView = (
  comparison: Comparison,
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
                : comparison.render(
                    side,
                    example,
                    step,
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
  comparison: Comparison,
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
        comparison,
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

const coverageView = (comparison: Comparison, h: HtmlBuilder<Message>): Html =>
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
  comparison: Comparison,
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
          previewView(comparison, example, index, `inspector-${finding.id}`, h),
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

// REVIEW

export const makeReview = (cases: ReadonlyArray<ComparisonCase>) => {
  const results = new Map<string, Comparison>()
  const checked = new WeakMap<
    Comparison,
    Readonly<{ count: number; groups: ReadonlyArray<PropertyGroup> }>
  >()
  const propertiesOf = (comparison: Comparison) => {
    const known = checked.get(comparison)
    if (
      known !== undefined &&
      known.count === comparison.propertyFailures.length
    ) {
      return known.groups
    }
    const groups = propertyGroups(comparison)
    checked.set(comparison, {
      count: comparison.propertyFailures.length,
      groups,
    })
    return groups
  }
  const comparisonOf = (model: Model): Option.Option<Comparison> => {
    const scenario =
      cases.find(item => item.name === model.scenario) ?? cases[0]
    if (scenario === undefined) {
      return Option.none()
    }
    const key = `${scenario.name}:${model.depth}`
    const known = results.get(key)
    if (known !== undefined) {
      return Option.some(known)
    }
    const result = scenario.run(model.depth)
    results.set(key, result)
    return Option.some(result)
  }
  const selected = (model: Model, comparison: Comparison) => {
    const groups = propertiesOf(comparison)
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

  const update = (model: Model, message: Message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      SelectedComparison: ({ name }) => ({
        model: resetSelection(
          modifyFields(model, { scenario: () => name, limit: () => PAGE }),
        ),
      }),
      SelectedFinding: ({ finding }) => ({
        model: modifyFields(resetSelection(model), {
          selection: () => Selection.Finding({ id: finding }),
        }),
      }),
      SelectedProperty: ({ property }) => ({
        model: modifyFields(resetSelection(model), {
          selection: () => Selection.Property({ id: property }),
        }),
      }),
      SelectedExample: ({ example }) => ({
        model: modifyFields(model, {
          example: () => Math.max(0, example),
          step: () => -1,
          replay: () => Replay.Idle(),
        }),
      }),
      SelectedTraceStep: ({ step }) => ({
        model: modifyFields(model, { step: () => Math.max(0, step) }),
      }),
      ClickedDeeper: () => ({
        model: resetSelection(
          modifyFields(model, { depth: depth => depth + 1, limit: () => PAGE }),
        ),
      }),
      ClickedShallower: () => ({
        model: resetSelection(
          modifyFields(model, {
            depth: depth => Math.max(0, depth - 1),
            limit: () => PAGE,
          }),
        ),
      }),
      ClickedShowMore: () => ({
        model: modifyFields(model, { limit: limit => limit + PAGE }),
      }),
      ClickedReset: () => ({
        model: modifyFields(initial(), { scenario: () => model.scenario }),
      }),
      ClickedReplay: () =>
        Option.match(comparisonOf(model), {
          onNone: () => ({ model }),
          onSome: comparison => {
            const selection = selected(model, comparison)
            if (selection === undefined) {
              return { model }
            }
            try {
              comparison.replay(selection.example.trace)
              return {
                model: modifyFields(model, {
                  step: () => 0,
                  replay: () => Replay.Verified(),
                }),
              }
            } catch (error) {
              return {
                model: modifyFields(model, {
                  replay: () =>
                    Replay.Failed({
                      reason:
                        error instanceof Error ? error.message : String(error),
                    }),
                }),
              }
            }
          },
        }),
    })

  const view = defineView<Model, Message, Readonly<{ mode: () => Html }>>(
    (model, inputs, h) =>
      Option.match(comparisonOf(model), {
        onNone: () =>
          h.div(
            [h.Class('lab')],
            [inputs.mode(), h.p([], ['No comparisons are registered.'])],
          ),
        onSome: comparison => {
          const selection = selected(model, comparison)
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
                          `${comparison.findings.length} findings · ${comparison.counters.pairs} pairs · ${statusLabel(comparison)}`,
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
                  comparison.status === 'complete'
                    ? 'Complete within the declared environment.'
                    : `Search stopped at the ${comparison.status.replace('-limit', '')} limit. Unfinished alternatives remain unknown.`,
                ],
              ),
              h.div(
                [h.Class('comparison-coverage')],
                [coverageView(comparison, h)],
              ),
              propertiesView(
                propertiesOf(comparison),
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
                                comparison,
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
  return { Model, Message, update, view }
}
