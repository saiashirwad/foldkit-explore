import { Array, Cause, Effect, Layer, Option, Record, Schema } from 'effect'
import { Command, Update } from 'foldkit'
import {
  type Document,
  type Html,
  type HtmlBuilder,
  createKeyedLazy,
} from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { AnalysisStatus, GallerySnapshot } from './analysis-data'
import {
  CHUNK_SIZE,
  failureStatus,
  immutable,
  makeRunner,
} from './analysis-runner'
import {
  Address,
  type Atlas,
  Search,
  type StateSnapshot,
  type Step,
} from './atlas'
import { canonical } from './canonical'
import { formatValue } from './display'
import * as Review from './review'

// MODEL

const Pin = Schema.Struct({ slot: Schema.String, address: Address })
const Mode = Schema.Literals(['Explore', 'Compare'])

export const Model = Schema.Struct({
  program: Schema.String,
  where: Schema.Record(Schema.String, Schema.String),
  depth: Schema.Number,
  search: Search,
  limit: Schema.Number,
  positions: Schema.Record(Schema.String, Address),
  pins: Schema.Array(Pin),
  maybeSelected: Schema.Option(Schema.String),
  mode: Mode,
  review: Review.Model,
  runId: Schema.Number,
  analysis: AnalysisStatus,
  maybeSnapshot: Schema.Option(GallerySnapshot),
})
export type Model = typeof Model.Type

type Card = Readonly<{
  slot: string
  home: string
  state: string
  states: ReadonlyArray<string>
}>

const PAGE = 48

const fresh = (program: string, search: Search = 'breadth'): Model => ({
  program,
  where: {},
  depth: 1,
  search,
  limit: PAGE,
  positions: {},
  pins: [],
  maybeSelected: Option.none(),
  mode: 'Explore',
  review: Review.initial(),
  runId: 0,
  analysis: AnalysisStatus.Idle(),
  maybeSnapshot: Option.none(),
})

const isMatching = (
  trace: ReadonlyArray<Step>,
  where: Readonly<Record<string, string>>,
): boolean =>
  Array.every(Record.toEntries(where), ([fixture, option]) =>
    Array.some(trace, step =>
      Array.some(
        step.decisions,
        decision => decision.fixture === fixture && decision.option === option,
      ),
    ),
  )

// MESSAGE

export const Message = defineMessageUnion({
  SelectedMode: { mode: Mode },
  GotReviewMessage: { message: Review.Message },
  SelectedProgram: { program: Schema.String },
  SelectedFilter: { fixture: Schema.String, option: Schema.String },
  ClearedFilter: { fixture: Schema.String },
  ClickedDeeper: {},
  ClickedShallower: {},
  SelectedSearch: { search: Search },
  ClickedShowMore: {},
  ClickedReset: {},
  ClickedCase: { slot: Schema.String },
  InteractedWithCase: {
    slot: Schema.String,
    state: Schema.String,
    message: Schema.Unknown,
  },
  ClickedStep: { slot: Schema.String, state: Schema.String },
  ClickedPin: { state: Schema.String },
  ClickedRestore: { slot: Schema.String },
  ClickedCancel: {},
  CompletedAnalyzeGallery: {
    runId: Schema.Number,
    status: AnalysisStatus,
    maybeSnapshot: Schema.Option(GallerySnapshot),
    positions: Schema.Record(Schema.String, Address),
  },
  CompletedDisposeGallery: {
    runId: Schema.Number,
    maybeFailure: Schema.Option(AnalysisStatus),
  },
})
export type Message = typeof Message.Type

const toReviewMessage = (message: Review.Message): Message => {
  const routed = Message.GotReviewMessage({ message })
  return immutable(routed)
}

const stateOf = (model: Model, id: string): StateSnapshot =>
  Option.getOrThrow(
    Option.flatMap(model.maybeSnapshot, snapshot =>
      Array.findFirst(snapshot.states, state => state.id === id),
    ),
  )

const cardsOf = (model: Model): ReadonlyArray<Card> =>
  Option.match(model.maybeSnapshot, {
    onNone: () => [],
    onSome: snapshot => {
      const byId = new Map(snapshot.states.map(state => [state.id, state]))
      const resolveKnown = (address: Address) =>
        snapshot.states.find(
          state => canonical(state.address) === canonical(address),
        )?.id
      const place = (
        slot: string,
        home: string,
        states: ReadonlyArray<string>,
      ): Card => ({
        slot,
        home,
        states,
        state: resolveKnown(model.positions[slot] ?? []) ?? states[0] ?? home,
      })
      return Array.filter(
        [
          ...Array.flatMap(model.pins, pin => {
            const home = resolveKnown(pin.address)
            return home === undefined ? [] : [place(pin.slot, home, [home])]
          }),
          ...Array.map(snapshot.groups, group =>
            place(
              byId.get(group.home)?.key ?? group.home,
              group.home,
              Array.filter(group.states, id =>
                isMatching(byId.get(id)?.trace ?? [], model.where),
              ),
            ),
          ),
        ],
        card => isMatching(byId.get(card.state)?.trace ?? [], model.where),
      )
    },
  })

// VIEW

const lazyCase = createKeyedLazy()

const filterView = (
  model: Model,
  fixture: string,
  options: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [
      h.Class(
        Record.has(model.where, fixture)
          ? 'lab-filter is-active'
          : 'lab-filter',
      ),
    ],
    [
      h.span([], [fixture]),
      h.select(
        [
          h.OnChange(option =>
            option === ''
              ? Message.ClearedFilter({ fixture })
              : Message.SelectedFilter({ fixture, option }),
          ),
        ],
        [
          h.option([h.Value('')], ['all']),
          ...Array.map(options, option =>
            h.option(
              [
                h.Value(option),
                h.Selected(
                  Option.contains(Record.get(model.where, fixture), option),
                ),
              ],
              [option],
            ),
          ),
        ],
      ),
    ],
  )

const depthView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('lab-depth')],
    [
      h.span([], ['depth']),
      h.button(
        [
          h.AriaLabel('Fewer steps'),
          h.Disabled(model.depth === 0),
          h.OnClick(Message.ClickedShallower()),
        ],
        ['−'],
      ),
      h.output([], [`${model.depth}`]),
      h.button(
        [
          h.AriaLabel('More steps'),
          h.Disabled(
            model.analysis._tag !== 'Completed' ||
              !Option.exists(
                model.maybeSnapshot,
                snapshot => snapshot.reached.status === 'depth-limit',
              ),
          ),
          h.OnClick(Message.ClickedDeeper()),
        ],
        ['+'],
      ),
    ],
  )

const searches: ReadonlyArray<readonly [Search, string, string]> = [
  [
    'breadth',
    'BFS',
    'Breadth-first: every state one step away before the next',
  ],
  ['depth', 'DFS', 'Depth-first: follow each path to the depth limit'],
  ['random', 'Random', 'Random walks: 32 seeded walks up to the depth limit'],
]

const searchView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('lab-search'), h.Role('group'), h.AriaLabel('Search')],
    Array.map(searches, ([search, label, title]) =>
      h.button(
        [
          h.Title(title),
          h.AriaPressed(search === model.search ? 'true' : 'false'),
          h.OnClick(Message.SelectedSearch({ search })),
        ],
        [label],
      ),
    ),
  )

// NOTE: Preview Models come from stable immutable snapshots, not a live Atlas.
const caseView = (
  atlas: Atlas,
  slot: string,
  state: string,
  previewModel: unknown,
  isSelected: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('article')(
    slot,
    [h.Class(isSelected ? 'case is-selected' : 'case')],
    [
      h.div(
        [h.Class('case-tools')],
        [
          h.button(
            [
              h.Class('case-inspect'),
              h.AriaPressed(isSelected ? 'true' : 'false'),
              h.OnClick(Message.ClickedCase({ slot })),
            ],
            ['Inspect'],
          ),
        ],
      ),
      h.div(
        [h.Class('case-preview')],
        [
          atlas.renderModel(previewModel, slot, h, caseMessage =>
            Message.InteractedWithCase({
              slot,
              state,
              message: caseMessage,
            }),
          ),
        ],
      ),
    ],
  )

const gridView = (
  model: Model,
  atlas: Atlas,
  cards: ReadonlyArray<Card>,
  maybeSelected: Option.Option<Card>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('lab-grid'), h.AriaLabel('States')],
    Array.match(cards, {
      onEmpty: () => [
        h.p(
          [h.Class('lab-empty')],
          [
            model.analysis._tag === 'Completed'
              ? 'No states match these filters.'
              : Review.analysisLabel(model.analysis),
          ],
        ),
      ],
      onNonEmpty: nonEmpty => [
        ...Array.map(Array.take(nonEmpty, model.limit), card =>
          lazyCase(card.slot, caseView, [
            atlas,
            card.slot,
            card.state,
            stateOf(model, card.state).model,
            Option.exists(maybeSelected, ({ slot }) => slot === card.slot),
            h,
          ]),
        ),
        nonEmpty.length > model.limit
          ? h.button(
              [h.Class('lab-more'), h.OnClick(Message.ClickedShowMore())],
              [`Show ${Math.min(PAGE, nonEmpty.length - model.limit)} more`],
            )
          : h.empty,
      ],
    }),
  )

const optionsOf = (step: Step): Step['decisions'] =>
  step.kind === 'Answer' ? step.decisions : []

// NOTE: An Answer's label is its Command, maybe a pending position, then its
// options. The head is the label without the options.
const headOf = (step: Step): string => {
  const options = Array.join(
    Array.map(optionsOf(step), ({ option }) => option),
    ' ',
  )
  return options !== '' && step.label.endsWith(options)
    ? step.label.slice(0, -options.length).trimEnd()
    : step.label
}

const stepRow = (
  slot: string,
  step: Step,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Class(isCurrent ? 'row is-current' : 'row'),
      h.AriaLabel(`${step.label} ${step.to}`),
      h.OnClick(Message.ClickedStep({ slot, state: step.to })),
    ],
    [
      h.span(
        [h.Class('row-label')],
        Array.match(optionsOf(step), {
          onEmpty: () => [step.label],
          onNonEmpty: options => [
            h.span([h.Class('row-command')], [headOf(step)]),
            ...Array.map(options, ({ fixture, option }) =>
              h.span(
                [h.Class('option'), h.Title(`${fixture}: ${option}`)],
                [option],
              ),
            ),
          ],
        }),
      ),
      h.span([h.Class('row-state')], [step.to]),
    ],
  )

const destinationView = (
  step: Step,
  current: string,
  h: HtmlBuilder<Message>,
): Html =>
  step.to === current
    ? h.span([h.Class('row-state is-same')], ['no change'])
    : h.span([h.Class('row-state')], [step.to])

const nextRow = (
  slot: string,
  current: string,
  step: Step,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Class('row'),
      h.AriaLabel(`${step.label} ${step.to}`),
      h.OnClick(Message.ClickedStep({ slot, state: step.to })),
    ],
    [
      h.span([h.Class('row-label')], [step.label]),
      destinationView(step, current, h),
    ],
  )

type Branch = Readonly<{
  depth: number
  decision: Step['decisions'][number]
  maybeStep: Option.Option<Step>
}>

type Remaining = Readonly<{ options: Step['decisions']; step: Step }>

// NOTE: Answers that share leading options share branches, so one Command's
// answers flatten into an outline. A branch ends in a step once its options run
// out.
const branchesOf = (
  remaining: ReadonlyArray<Remaining>,
  depth: number,
): ReadonlyArray<Branch> =>
  Array.isReadonlyArrayNonEmpty(remaining)
    ? Array.flatMap(
        Array.groupWith(remaining, (left, right) =>
          Option.exists(Array.head(left.options), first =>
            Option.exists(
              Array.head(right.options),
              other =>
                other.fixture === first.fixture &&
                other.option === first.option,
            ),
          ),
        ),
        group =>
          Option.match(Array.head(Array.headNonEmpty(group).options), {
            onNone: () => [],
            onSome: decision => {
              const rest = Array.map(group, ({ options, step }) => ({
                options: Array.drop(options, 1),
                step,
              }))
              return [
                {
                  depth,
                  decision,
                  maybeStep: Option.map(
                    Array.findFirst(rest, ({ options }) =>
                      Array.isReadonlyArrayEmpty(options),
                    ),
                    ({ step }) => step,
                  ),
                },
                ...branchesOf(
                  Array.filter(rest, ({ options }) =>
                    Array.isReadonlyArrayNonEmpty(options),
                  ),
                  depth + 1,
                ),
              ]
            },
          }),
      )
    : []

const answersView = (
  slot: string,
  current: string,
  steps: ReadonlyArray<Step>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('tree')],
    [
      ...Array.map(
        Array.filter(steps, step => Array.isReadonlyArrayEmpty(step.decisions)),
        step => nextRow(slot, current, step, h),
      ),
      ...Array.map(
        branchesOf(
          Array.map(steps, step => ({ options: optionsOf(step), step })),
          0,
        ),
        ({ depth, decision, maybeStep }) => {
          const label = [
            h.span([h.Class('tree-key')], [decision.fixture]),
            h.span([h.Class('tree-value')], [decision.option]),
          ]
          const style = h.Style({ '--depth': `${depth}` })
          return Option.match(maybeStep, {
            onNone: () => h.div([h.Class('tree-row'), style], label),
            onSome: step =>
              h.button(
                [
                  h.Class('tree-row is-leaf'),
                  style,
                  h.AriaLabel(`${step.label} ${step.to}`),
                  h.OnClick(Message.ClickedStep({ slot, state: step.to })),
                ],
                [...label, destinationView(step, current, h)],
              ),
          })
        },
      ),
    ],
  )

const nextView = (
  slot: string,
  current: string,
  steps: ReadonlyArray<Step>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const moves = Array.filter(steps, step => step.kind === 'Move')
  const answers = Array.filter(steps, step => step.kind === 'Answer')
  return [
    ...(Array.isReadonlyArrayNonEmpty(moves)
      ? [
          h.div(
            [h.Class('next-group')],
            [
              h.div([h.Class('next-title')], ['User actions']),
              ...Array.map(moves, step => nextRow(slot, current, step, h)),
            ],
          ),
        ]
      : []),
    ...(Array.isReadonlyArrayNonEmpty(answers)
      ? Array.map(
          Array.groupWith(
            answers,
            (left, right) => headOf(left) === headOf(right),
          ),
          group =>
            h.div(
              [h.Class('next-group')],
              [
                h.div(
                  [h.Class('next-title')],
                  [
                    h.code([], [headOf(Array.headNonEmpty(group))]),
                    ' replies with',
                  ],
                ),
                answersView(slot, current, group, h),
              ],
            ),
        )
      : []),
  ]
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/

const tokenKind = (parts: ReadonlyArray<string>, index: number): string => {
  const token = parts[index] ?? ''
  if (!token.startsWith('"')) {
    return /^[tfn]/.test(token) ? 'literal' : 'number'
  }
  if ((parts[index + 1] ?? '').trimStart().startsWith(':')) {
    return 'key'
  }
  return parts[index - 2] === '"_tag"' ? 'tag' : 'string'
}

// NOTE: Splitting on a capturing pattern alternates text and tokens, so odd
// parts are tokens.
const modelView = (value: unknown, h: HtmlBuilder<Message>): Html => {
  const parts = formatValue(value, 2)
    .replace(/\{\n\s*("_tag": "[^"]*")\n\s*\}/g, '{ $1 }')
    .split(JSON_TOKEN)
  return h.pre(
    [h.Class('inspector-model')],
    Array.map(parts, (part, index) =>
      index % 2 === 0
        ? part
        : h.span([h.Class(`json-${tokenKind(parts, index)}`)], [part]),
    ),
  )
}

const inspectorSection = (
  kind: string,
  title: string,
  hint: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.isReadonlyArrayEmpty(children)
    ? h.empty
    : h.section(
        [h.Class(`inspector-section is-${kind}`)],
        [
          h.h4([], [title]),
          hint === '' ? h.empty : h.p([h.Class('inspector-hint')], [hint]),
          h.div([h.Class('inspector-body')], children),
        ],
      )

const inspectorDetails = (
  title: string,
  note: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.details(
    [h.Class('inspector-details')],
    [
      h.summary([], [title, h.span([h.Class('inspector-note')], [note])]),
      h.div([h.Class('inspector-body')], children),
    ],
  )

const inspectorView = (
  atlas: Atlas,
  card: Card,
  model: Model,
  snapshot: GallerySnapshot,
  h: HtmlBuilder<Message>,
): Html => {
  const depth = snapshot.depth
  const search = snapshot.search
  const current = stateOf(model, card.state)
  const failures = snapshot.failures
  const reached = snapshot.reached
  const isComplete =
    model.analysis._tag === 'Completed' && reached.status === 'complete'
  const trace = current.trace
  const distance = trace.length - 1
  const next = current.next
  const nextHint =
    current.successorStatus === 'complete'
      ? 'Click one to step this preview there.'
      : 'Showing explored choices. More alternatives remain unknown at the current search limits.'
  return h.aside(
    [h.Class('inspector'), h.AriaLabel('Selected state')],
    [
      h.header(
        [h.Class('inspector-head')],
        [
          h.div(
            [h.Class('inspector-title')],
            [
              h.strong([], [card.state]),
              h.span(
                [],
                [
                  distance === 0
                    ? 'A starting state'
                    : `${distance} ${distance === 1 ? 'step' : 'steps'} from the start`,
                ],
              ),
            ],
          ),
          card.home === card.state
            ? h.empty
            : h.button(
                [
                  h.Class('lab-quiet'),
                  h.OnClick(Message.ClickedRestore({ slot: card.slot })),
                ],
                ['Restore'],
              ),
          h.button(
            [
              h.Class('lab-quiet'),
              h.OnClick(Message.ClickedPin({ state: card.state })),
            ],
            ['Pin'],
          ),
        ],
      ),
      inspectorSection(
        'trace',
        'How it got here',
        '',
        Array.map(trace, step =>
          stepRow(card.slot, step, step.to === card.state, h),
        ),
        h,
      ),
      inspectorSection(
        'pending',
        'Waiting on',
        'In-flight Commands. Their replies are listed below.',
        Array.map(current.pending, ({ name, args }) =>
          h.div(
            [h.Class('pending')],
            [
              h.code([], [name]),
              args === '{}'
                ? h.empty
                : h.code([h.Class('pending-args')], [args]),
            ],
          ),
        ),
        h,
      ),
      inspectorSection(
        'next',
        'What can happen next',
        nextHint,
        nextView(card.slot, card.state, next, h),
        h,
      ),
      card.states.length > 1
        ? inspectorDetails(
            'Same screen',
            `${card.states.length} states`,
            [
              h.p(
                [],
                [
                  'These states render identically but differ in their Model or in-flight Commands.',
                ],
              ),
              ...Array.map(card.states, state =>
                h.button(
                  [
                    h.Class(state === card.state ? 'row is-current' : 'row'),
                    h.OnClick(Message.ClickedStep({ slot: card.slot, state })),
                  ],
                  [
                    h.span([h.Class('row-label')], [state]),
                    h.span(
                      [h.Class('row-state')],
                      [`${stateOf(model, state).pending.length} in flight`],
                    ),
                  ],
                ),
              ),
            ],
            h,
          )
        : h.empty,
      inspectorDetails('Model', '', [modelView(current.encodedModel, h)], h),
      Array.isReadonlyArrayEmpty(atlas.propertyNames)
        ? h.empty
        : inspectorDetails(
            'Properties',
            failures.length === 0
              ? 'No violations found'
              : `${failures.length} failing`,
            [
              h.ul(
                [],
                Array.map(atlas.propertyNames, name =>
                  h.li(
                    [
                      h.Class(
                        Array.some(
                          failures,
                          failure => failure.property === name,
                        )
                          ? 'is-failing'
                          : 'is-holding',
                      ),
                    ],
                    [name],
                  ),
                ),
              ),
              ...Array.map(failures, failure =>
                h.section(
                  [],
                  [
                    h.h4([], [failure.property]),
                    ...Array.map(failure.trace, step =>
                      stepRow(card.slot, step, step.to === card.state, h),
                    ),
                  ],
                ),
              ),
              h.p(
                [],
                [
                  `Breadth-first checks through depth ${depth}, independently of the gallery search. Checked only reached states and transitions, not all possible executions.`,
                ],
              ),
            ],
            h,
          ),
      inspectorDetails(
        'About this search',
        isComplete ? 'complete' : 'incomplete',
        [
          h.p(
            [],
            [
              'Transitions and pending Command selection are defined by next(state).',
            ],
          ),
          h.p(
            [],
            [
              `${Option.getOrElse(
                Option.map(
                  Array.findFirst(searches, ([key]) => key === search),
                  ([, , title]) => title,
                ),
                () => search,
              )}.`,
            ],
          ),
          h.p(
            [],
            [
              `Depth ${depth}; limits ${atlas.limits.states} states, ${atlas.limits.transitions} alternatives, and ${atlas.limits.enumerationWork} enumeration work; ${isComplete ? 'complete within declared environment' : reached.status}.`,
            ],
          ),
          h.p([], [atlas.grouping]),
          h.p(
            [],
            [
              'View-driven moves cover enabled buttons and configured text inputs only. Other programs choose Messages explicitly in next(state).',
            ],
          ),
        ],
        h,
      ),
    ],
  )
}

// LAB

export const makeLab = (
  atlases: Array.NonEmptyReadonlyArray<Atlas>,
  comparisons: ReadonlyArray<Review.ComparisonCase> = [],
) => {
  const review = Review.makeReview(comparisons)
  const foldReview = Update.foldChild({
    update: review.update,
    read: (model: Model) => Option.some(model.review),
    write: (model, nextReview) =>
      modifyFields(model, { review: () => nextReview }),
    toParentMessage: toReviewMessage,
  })
  const atlasOf = (model: Pick<Model, 'program'>): Atlas =>
    Option.getOrElse(
      Array.findFirst(atlases, atlas => atlas.name === model.program),
      () => Array.headNonEmpty(atlases),
    )

  type Resource = {
    atlas: Atlas
    job:
      | Iterator<
          void,
          Readonly<{ snapshot: GallerySnapshot; positions: Model['positions'] }>
        >
      | undefined
    dispose: () => void
  }
  const runner = makeRunner<Resource>()
  const Interaction = Schema.Struct({
    slot: Schema.String,
    address: Address,
    message: Schema.Unknown,
  })
  const AnalyzeGallery = Command.define('AnalyzeGallery', {
    args: {
      runId: Schema.Number,
      program: Schema.String,
      depth: Schema.Number,
      search: Search,
      reset: Schema.Boolean,
      chunks: Schema.Number,
      positions: Model.fields.positions,
      maybeSelected: Model.fields.maybeSelected,
      pins: Model.fields.pins,
      maybeInteraction: Schema.Option(Interaction),
    },
    messages: [Message.CompletedAnalyzeGallery],
    execute: args =>
      runner
        .run(
          { runId: args.runId, key: args.program, reset: args.reset },
          () => {
            const atlas = atlasOf(args).fresh()
            const resource: Resource = {
              atlas,
              job: undefined,
              dispose: () => {
                try {
                  resource.job?.return?.()
                } finally {
                  atlas.dispose()
                }
              },
            }
            return resource
          },
          (resource, newRun) => {
            if (newRun) {
              resource.job?.return?.()
              resource.job = (function* () {
                const atlas = resource.atlas
                for (const address of [
                  ...Record.values(args.positions),
                  ...args.pins.map(pin => pin.address),
                ]) {
                  yield* atlas.resolveSteps(address)
                }
                const moved = { positions: args.positions }
                if (Option.isSome(args.maybeInteraction)) {
                  const interaction = args.maybeInteraction.value
                  const source = yield* atlas.resolveSteps(interaction.address)
                  if (Option.isSome(source)) {
                    moved.positions = Option.match(
                      atlas.interact(source.value, interaction.message),
                      {
                        onNone: () => args.positions,
                        onSome: destination =>
                          Record.set(
                            args.positions,
                            interaction.slot,
                            atlas.address(destination),
                          ),
                      },
                    )
                  }
                }
                const positions = moved.positions
                const reached = yield* atlas.explore(args.depth, args.search)
                if (
                  Array.isReadonlyArrayNonEmpty(atlas.propertyNames) &&
                  args.search !== 'breadth'
                ) {
                  yield* atlas.explore(args.depth, 'breadth')
                }
                const failures = Array.isReadonlyArrayEmpty(atlas.propertyNames)
                  ? []
                  : yield* atlas.checkSteps(args.depth)
                const groups = yield* atlas.groupSteps(reached.states)
                const preliminary: GallerySnapshot = {
                  depth: args.depth,
                  search: args.search,
                  reached,
                  states: yield* atlas.snapshotSteps(),
                  groups,
                  fixtures: atlas.fixtures(),
                  failures: [],
                }
                const temporary = {
                  ...fresh(args.program, args.search),
                  positions,
                  pins: args.pins,
                  maybeSelected: args.maybeSelected,
                  maybeSnapshot: Option.some(preliminary),
                }
                const cards = cardsOf(temporary)
                const selected =
                  cards.find(card =>
                    Option.contains(args.maybeSelected, card.slot),
                  ) ?? cards[0]
                if (selected !== undefined) {
                  yield* atlas.probe(selected.state)
                }
                return {
                  snapshot: {
                    depth: args.depth,
                    search: args.search,
                    reached,
                    states: yield* atlas.snapshotSteps(),
                    groups,
                    fixtures: atlas.fixtures(),
                    failures,
                  },
                  positions,
                }
              })()
            }
            const job = resource.job
            if (job === undefined) {
              throw new Error('Gallery analysis was not initialized.')
            }
            const cursor = { remaining: CHUNK_SIZE, step: job.next() }
            while (!cursor.step.done && cursor.remaining > 1) {
              cursor.remaining -= 1
              cursor.step = job.next()
            }
            return {
              done: cursor.step.done === true,
              value: cursor.step.done
                ? Option.some(cursor.step.value)
                : Option.none<
                    Readonly<{
                      snapshot: GallerySnapshot
                      positions: Model['positions']
                    }>
                  >(),
            }
          },
          args.chunks,
        )
        .pipe(
          Effect.map(result =>
            immutable(
              Message.CompletedAnalyzeGallery({
                runId: args.runId,
                status: result.status,
                maybeSnapshot: Option.flatMap(result.maybeValue, value =>
                  Option.map(value, result => result.snapshot),
                ),
                positions: Option.match(Option.flatten(result.maybeValue), {
                  onNone: () => args.positions,
                  onSome: result => result.positions,
                }),
              }),
            ),
          ),
          Effect.catchCause(cause =>
            Effect.exit(runner.cancel(args.runId)).pipe(
              Effect.as(
                Message.CompletedAnalyzeGallery({
                  runId: args.runId,
                  status: failureStatus(Cause.squash(cause)),
                  maybeSnapshot: Option.none(),
                  positions: args.positions,
                }),
              ),
            ),
          ),
        ),
  })
  const DisposeGallery = Command.define('DisposeGallery', {
    args: { runId: Schema.Number },
    messages: [Message.CompletedDisposeGallery],
    execute: ({ runId }) =>
      runner.cancel(runId).pipe(
        Effect.as(
          Message.CompletedDisposeGallery({
            runId,
            maybeFailure: Option.none(),
          }),
        ),
        Effect.catchCause(cause =>
          Effect.succeed(
            Message.CompletedDisposeGallery({
              runId,
              maybeFailure: Option.some(failureStatus(Cause.squash(cause))),
            }),
          ),
        ),
      ),
  })
  const continueAnalysis = (
    model: Model,
    reset = false,
    maybeInteraction: Option.Option<typeof Interaction.Type> = Option.none(),
  ): Update.Return<Model, Message> => ({
    model,
    commands: [
      AnalyzeGallery({
        runId: model.runId,
        program: model.program,
        depth: model.depth,
        search: model.search,
        reset,
        chunks: model.analysis._tag === 'Running' ? model.analysis.chunks : 0,
        positions: model.positions,
        pins: model.pins,
        maybeSelected: model.maybeSelected,
        maybeInteraction,
      }),
    ],
  })
  const start = (
    model: Model,
    reset = false,
    maybeInteraction: Option.Option<typeof Interaction.Type> = Option.none(),
  ): Update.Return<Model, Message> =>
    continueAnalysis(
      modifyFields(model, {
        runId: id => id + 1,
        analysis: () => AnalysisStatus.Running({ chunks: 0 }),
      }),
      reset,
      maybeInteraction,
    )
  const cancel = (model: Model): Update.Return<Model, Message> => {
    const next = modifyFields(model, {
      runId: id => id + 1,
      analysis: () => AnalysisStatus.Cancelled(),
    })
    return { model: next, commands: [DisposeGallery({ runId: next.runId })] }
  }

  const reset = (
    model: Model,
    program: string,
    search: Search,
  ): Update.Return<Model, Message> => {
    const stopped = review.cancel(model.review)
    const started = start(
      modifyFields(fresh(program, search), {
        runId: () => model.runId,
        review: () => stopped.model,
      }),
      true,
    )
    return {
      model: started.model,
      commands: [
        ...(Command.mapMessages(stopped.commands, toReviewMessage) ?? []),
        ...(started.commands ?? []),
      ],
    }
  }

  // INIT

  const init = (): Update.Return<Model, Message> =>
    start(fresh(Array.headNonEmpty(atlases).name))

  // UPDATE

  const moveTo = (model: Model, slot: string, state: string): Model =>
    modifyFields(model, {
      positions: positions =>
        Record.set(positions, slot, stateOf(model, state).address),
      maybeSelected: () => Option.some(slot),
    })

  const update = (model: Model, message: Message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      SelectedMode: ({ mode }) => {
        if (mode === model.mode) {
          return { model }
        }
        if (mode === 'Compare') {
          const stopped = cancel(model)
          const started = review.start(model.review)
          return {
            model: modifyFields(stopped.model, {
              mode: () => mode,
              review: () => started.model,
            }),
            commands: [
              ...(stopped.commands ?? []),
              ...(Command.mapMessages(started.commands, toReviewMessage) ?? []),
            ],
          }
        }
        const stopped = review.cancel(model.review)
        const started = start(
          modifyFields(model, {
            mode: () => mode,
            review: () => stopped.model,
          }),
          true,
        )
        return {
          model: started.model,
          commands: [
            ...(Command.mapMessages(stopped.commands, toReviewMessage) ?? []),
            ...(started.commands ?? []),
          ],
        }
      },
      GotReviewMessage: ({ message: reviewMessage }) =>
        foldReview(model, reviewMessage),
      SelectedProgram: ({ program }) => reset(model, program, model.search),
      SelectedFilter: ({ fixture, option }) => ({
        model: modifyFields(model, {
          where: where => Record.set(where, fixture, option),
          limit: () => PAGE,
        }),
      }),
      ClearedFilter: ({ fixture }) => ({
        model: modifyFields(model, {
          where: where => Record.remove(where, fixture),
        }),
      }),
      ClickedDeeper: () =>
        start(modifyFields(model, { depth: depth => depth + 1 })),
      ClickedShallower: () =>
        start(modifyFields(model, { depth: depth => Math.max(0, depth - 1) })),
      SelectedSearch: ({ search }) =>
        start(modifyFields(model, { search: () => search, limit: () => PAGE })),
      ClickedShowMore: () => ({
        model: modifyFields(model, { limit: limit => limit + PAGE }),
      }),
      ClickedReset: () => reset(model, model.program, 'breadth'),
      ClickedCase: ({ slot }) =>
        start(modifyFields(model, { maybeSelected: () => Option.some(slot) })),
      InteractedWithCase: ({ slot, state, message: caseMessage }) =>
        start(
          modifyFields(model, { maybeSelected: () => Option.some(slot) }),
          false,
          Option.some({
            slot,
            address: stateOf(model, state).address,
            message: caseMessage,
          }),
        ),
      ClickedStep: ({ slot, state }) => start(moveTo(model, slot, state)),
      ClickedPin: ({ state }) => {
        const slot = `pin ${model.pins.length + 1}`
        return start(
          modifyFields(model, {
            pins: pins =>
              Array.append(pins, {
                slot,
                address: stateOf(model, state).address,
              }),
            maybeSelected: () => Option.some(slot),
          }),
        )
      },
      ClickedRestore: ({ slot }) =>
        start(
          modifyFields(model, {
            positions: positions => Record.remove(positions, slot),
          }),
        ),
      ClickedCancel: () => cancel(model),
      CompletedAnalyzeGallery: ({
        runId,
        status,
        maybeSnapshot,
        positions,
      }) => {
        if (runId !== model.runId || model.analysis._tag !== 'Running') {
          return { model }
        }
        const next = modifyFields(model, {
          analysis: () => status,
          maybeSnapshot: previous =>
            Option.orElse(maybeSnapshot, () => previous),
          positions: previous =>
            status._tag === 'Completed' ? positions : previous,
        })
        return status._tag === 'Running'
          ? continueAnalysis(next)
          : { model: next }
      },
      CompletedDisposeGallery: ({ runId, maybeFailure }) => ({
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

  // VIEW

  const modeView = (model: Model, h: HtmlBuilder<Message>): Html =>
    Array.isReadonlyArrayEmpty(comparisons)
      ? h.empty
      : h.div(
          [h.Class('lab-search'), h.Role('group'), h.AriaLabel('Mode')],
          Array.map(Mode.literals, mode =>
            h.button(
              [
                h.AriaPressed(model.mode === mode ? 'true' : 'false'),
                h.OnClick(Message.SelectedMode({ mode })),
              ],
              [mode],
            ),
          ),
        )

  const programView = (model: Model, h: HtmlBuilder<Message>): Html =>
    h.select(
      [
        h.AriaLabel('Program'),
        h.Class('lab-program'),
        h.OnChange(program => Message.SelectedProgram({ program })),
      ],
      Array.map(atlases, ({ name }) =>
        h.option([h.Value(name), h.Selected(name === model.program)], [name]),
      ),
    )

  const headerView = (
    model: Model,
    cards: ReadonlyArray<Card>,
    h: HtmlBuilder<Message>,
  ): Html => {
    const reached = Option.map(
      model.maybeSnapshot,
      snapshot => snapshot.reached,
    )
    return h.header(
      [h.Class('lab-header')],
      [
        modeView(model, h),
        programView(model, h),
        h.div(
          [h.Class('lab-filters')],
          Array.map(
            Option.match(model.maybeSnapshot, {
              onNone: () => [],
              onSome: snapshot => snapshot.fixtures,
            }),
            ({ name, options }) => filterView(model, name, options, h),
          ),
        ),
        h.div(
          [h.Class('lab-header-end')],
          [
            h.span(
              [h.Class('lab-count')],
              [
                `${cards.length} groups · ${Option.match(reached, { onNone: () => 0, onSome: result => result.states.length })} states · ${model.analysis._tag === 'Completed' ? Option.match(reached, { onNone: () => 'unknown', onSome: result => (result.status === 'complete' ? 'complete' : `incomplete · ${result.status}`) }) : Review.analysisLabel(model.analysis)}`,
              ],
            ),
            searchView(model, h),
            depthView(model, h),
            model.analysis._tag === 'Running'
              ? h.button(
                  [h.Class('lab-quiet'), h.OnClick(Message.ClickedCancel())],
                  ['Cancel'],
                )
              : h.empty,
            h.button(
              [h.Class('lab-quiet'), h.OnClick(Message.ClickedReset())],
              ['Reset'],
            ),
          ],
        ),
      ],
    )
  }

  const view = (model: Model, h: HtmlBuilder<Message>): Document => {
    if (model.mode === 'Compare') {
      return {
        title: 'Compare UI versions',
        body: h.submodel({
          slotId: 'comparison-review',
          model: model.review,
          view: review.view,
          viewInputs: { mode: () => modeView(model, h) },
          toParentMessage: toReviewMessage,
        }),
      }
    }
    const atlas = atlasOf(model)
    const cards = cardsOf(model)
    const maybeSelected = Option.orElse(
      Option.flatMap(model.maybeSelected, slot =>
        Array.findFirst(cards, card => card.slot === slot),
      ),
      () => Array.head(cards),
    )
    return {
      title: atlas.name,
      body: h.div(
        [h.Class('lab')],
        [
          headerView(model, cards, h),
          h.main(
            [h.Class('lab-workspace')],
            [
              gridView(model, atlas, cards, maybeSelected, h),
              Option.match(maybeSelected, {
                onNone: () => h.empty,
                onSome: card =>
                  Option.match(model.maybeSnapshot, {
                    onNone: () => h.empty,
                    onSome: snapshot =>
                      inspectorView(atlas, card, model, snapshot, h),
                  }),
              }),
            ],
          ),
        ],
      ),
    }
  }

  const dispose = Effect.all([runner.shutdown, review.dispose]).pipe(
    Effect.asVoid,
  )
  const resources = Layer.merge(
    review.resources,
    Layer.effectDiscard(Effect.addFinalizer(() => runner.shutdown)),
  )
  return { Model, Message, init, update, view, dispose, resources }
}
