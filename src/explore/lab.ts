import { Array, Option, Schema } from 'effect'
import type { Update } from 'foldkit'
import {
  type Document,
  type Html,
  type HtmlBuilder,
  createLazy,
} from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import { deadEnds } from './check'
import { type Choices, fixture } from './choices'
import { type Comparison, type Finding, compare } from './compare'
import {
  type Environment,
  type Limits,
  type Move,
  type Program,
  type State,
  defaultKey,
  explore,
  send,
} from './explore'
import { keyOf } from './key'

// CASE

// One program and environment, with their types erased for the picker.
export type Case = Readonly<{
  name: string
  run: (limits: Limits, clicks: ReadonlyArray<Click>) => Result
}>

// A Message the user fired by clicking inside a state's preview.
const Click = Schema.Struct({ key: Schema.String, message: Schema.Unknown })
type Click = typeof Click.Type

type Result = Readonly<{
  cards: ReadonlyArray<Card>
  total: number
  isComplete: boolean
}>

type Card = Readonly<{
  key: string
  id: number
  depth: number
  isDeadEnd: boolean
  via: string
  commands: string
  render: (h: HtmlBuilder<Message>) => Html
}>

const STATES = 200

// Adds what was clicked to the moves the environment already offers.
const withClicks = <ProgramModel, ProgramMessage, Input>(
  program: Program<ProgramModel, ProgramMessage, Input>,
  environment: Environment<ProgramModel, ProgramMessage, Input>,
  clicks: ReadonlyArray<Click>,
): Environment<ProgramModel, ProgramMessage, Input> => {
  const isMessage = Schema.is(program.Message)
  const clicked = Array.reduce(
    clicks,
    new Map<string, Record<string, ProgramMessage>>(),
    (byKey, click) => {
      if (isMessage(click.message)) {
        byKey.set(click.key, {
          ...byKey.get(click.key),
          [keyOf(click.message)]: click.message,
        })
      }
      return byKey
    },
  )
  const declared = environment.next
  function* next(
    state: State<ProgramModel, ProgramMessage, Input>,
  ): Choices<Move<ProgramMessage>> {
    const messages = clicked.get(
      keyOf(environment.key?.(state) ?? defaultKey(state)),
    )
    if (messages === undefined) {
      return declared === undefined
        ? yield* fixture('moves', {})
        : yield* declared(state)
    }
    const source =
      declared === undefined
        ? 'clicked'
        : yield* fixture('source', {
            declared: 'declared',
            clicked: 'clicked',
          })
    return source === 'clicked' || declared === undefined
      ? send(yield* fixture('click', messages))
      : yield* declared(state)
  }
  return { ...environment, next }
}

export const makeCase = <ProgramModel, ProgramMessage, Input>(
  program: Program<ProgramModel, ProgramMessage, Input>,
  environment: Environment<ProgramModel, ProgramMessage, Input>,
): Case => {
  const view = defineView<ProgramModel, ProgramMessage>(program.view)
  return {
    name: program.name,
    run: (limits, clicks) => {
      const graph = explore(
        program,
        withClicks(program, environment, clicks),
        limits,
      )
      const ends = new Set(deadEnds(graph, limits.depth).map(({ id }) => id))
      return {
        total: graph.nodes.length,
        isComplete: graph.isComplete,
        cards: Array.map(
          Array.filter(graph.nodes, node => node.shown),
          node => ({
            key: node.key,
            id: node.id,
            depth: node.depth,
            isDeadEnd: ends.has(node.id),
            via: node.via.join(' · '),
            commands: Array.map(node.pending, command => command.name).join(
              ', ',
            ),
            render: (h: HtmlBuilder<Message>) =>
              h.submodel({
                slotId: `state-${node.id}`,
                model: node.model,
                view,
                toParentMessage: message =>
                  Message.InteractedWithState({
                    key: node.key,
                    depth: node.depth,
                    message,
                  }),
              }),
          }),
        ),
      }
    },
  }
}

// One pair of versions in one environment, with their types erased.
export type ComparisonCase = Readonly<{
  name: string
  run: (limits: Limits) => Comparison
}>

export const makeComparison = <ProgramModel, ProgramMessage, Input>(
  name: string,
  before: Program<ProgramModel, ProgramMessage, Input>,
  after: Program<ProgramModel, ProgramMessage, Input>,
  environment: Environment<ProgramModel, ProgramMessage, Input>,
): ComparisonCase => ({
  name,
  run: limits => compare(before, after, environment, limits),
})

// MODEL

const Mode = Schema.Literals(['Explore', 'Compare'])

export const Model = Schema.Struct({
  mode: Mode,
  comparison: Schema.String,
  program: Schema.String,
  depth: Schema.Number,
  pruned: Schema.Array(Schema.String),
  clicks: Schema.Array(Click),
})
export type Model = typeof Model.Type

const MAX_DEPTH = 8

// MESSAGE

export const Message = defineMessageUnion({
  SelectedMode: { mode: Mode },
  SelectedComparison: { comparison: Schema.String },
  SelectedProgram: { program: Schema.String },
  ClickedShallower: {},
  ClickedDeeper: {},
  ClickedPrune: { key: Schema.String },
  ClickedReset: {},
  InteractedWithState: {
    key: Schema.String,
    depth: Schema.Number,
    message: Schema.Unknown,
  },
})
export type Message = typeof Message.Type

// VIEW

const lazy = createLazy()
const lazyCompare = createLazy()

const cardView = (card: Card, h: HtmlBuilder<Message>): Html =>
  h.article(
    [h.Class('state')],
    [
      h.div(
        [h.Class('state-head')],
        [
          h.span([h.Class('state-id')], [`S${card.id + 1}`]),
          h.span([h.Class('state-via')], [card.via]),
          card.isDeadEnd
            ? h.span([h.Class('state-end')], ['dead end'])
            : h.empty,
          h.button(
            [
              h.Class('lab-quiet'),
              h.AriaLabel(`Prune S${card.id + 1}`),
              h.OnClick(Message.ClickedPrune({ key: card.key })),
            ],
            ['Prune'],
          ),
        ],
      ),
      h.div([h.Class('state-preview')], [card.render(h)]),
      card.commands === ''
        ? h.empty
        : h.p([h.Class('state-commands')], [`pending: ${card.commands}`]),
    ],
  )

// NOTE: Pruned states are keyed by the default key, so the rule only matches
// an environment that has not set its own `key`.
const ruleOf = (keys: ReadonlyArray<string>): string =>
  [
    'const pruned = new Set([',
    ...Array.map(keys, key => `  ${JSON.stringify(key)},`),
    '])',
    '',
    '// in the Environment:',
    'prune: state => pruned.has(keyOf(defaultKey(state))),',
  ].join('\n')

const countView = (result: Result, pruned: number): string =>
  [
    `${result.total} states`,
    result.isComplete ? 'complete' : 'cut off',
    ...(pruned > 0 ? [`${pruned} pruned`] : []),
  ].join(' · ')

const nameOf = <Named extends Readonly<{ name: string }>>(
  items: Array.NonEmptyReadonlyArray<Named>,
  name: string,
): Named =>
  Option.getOrElse(
    Array.findFirst(items, item => item.name === name),
    () => Array.headNonEmpty(items),
  )

const depthView = (depth: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('lab-depth')],
    [
      h.span([], ['depth']),
      h.button(
        [
          h.AriaLabel('Fewer steps'),
          h.Disabled(depth === 0),
          h.OnClick(Message.ClickedShallower()),
        ],
        ['−'],
      ),
      h.output([], [`${depth}`]),
      h.button(
        [
          h.AriaLabel('More steps'),
          h.Disabled(depth === MAX_DEPTH),
          h.OnClick(Message.ClickedDeeper()),
        ],
        ['+'],
      ),
    ],
  )

const modeView = (
  mode: typeof Mode.Type,
  hasComparisons: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  hasComparisons
    ? h.div(
        [h.Class('lab-depth')],
        Array.map(Mode.literals, option =>
          h.button(
            [
              h.AriaPressed(option === mode ? 'true' : 'false'),
              h.OnClick(Message.SelectedMode({ mode: option })),
            ],
            [option],
          ),
        ),
      )
    : h.empty

const pickerView = (
  label: string,
  names: ReadonlyArray<string>,
  selected: string,
  toMessage: (name: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.select(
    [h.AriaLabel(label), h.OnChange(toMessage)],
    Array.map(names, name =>
      h.option([h.Value(name), h.Selected(name === selected)], [name]),
    ),
  )

const gridView = (
  cases: Array.NonEmptyReadonlyArray<Case>,
  hasComparisons: boolean,
  program: string,
  depth: number,
  pruned: string,
  clicks: ReadonlyArray<Click>,
  h: HtmlBuilder<Message>,
): Html => {
  const keys: ReadonlyArray<string> = JSON.parse(pruned)
  const result = nameOf(cases, program).run(
    { depth, states: STATES, exclude: new Set(keys) },
    clicks,
  )
  return h.div(
    [],
    [
      h.header(
        [h.Class('lab-header')],
        [
          modeView('Explore', hasComparisons, h),
          pickerView(
            'Program',
            Array.map(cases, ({ name }) => name),
            program,
            name => Message.SelectedProgram({ program: name }),
            h,
          ),
          depthView(depth, h),
          h.span([h.Class('lab-count')], [countView(result, keys.length)]),
          keys.length > 0 || clicks.length > 0
            ? h.button(
                [h.Class('lab-quiet'), h.OnClick(Message.ClickedReset())],
                ['Reset'],
              )
            : h.empty,
        ],
      ),
      keys.length > 0
        ? h.details(
            [h.Class('lab-rule')],
            [
              h.summary([], ['Prune rule for your code']),
              h.pre([], [ruleOf(keys)]),
            ],
          )
        : h.empty,
      h.section(
        [h.Class('lab-grid'), h.AriaLabel('States')],
        Array.map(result.cards, card => cardView(card, h)),
      ),
    ],
  )
}

const findingLabels: Readonly<Record<Finding['kind'], string>> = {
  screen: 'Screen differs',
  commands: 'Pending requests differ',
  'only-before': 'Move removed',
  'only-after': 'Move added',
}

const findingView = (finding: Finding, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Class('finding')],
    [
      h.div(
        [h.Class('finding-head')],
        [
          h.strong([], [findingLabels[finding.kind]]),
          h.span([], [`× ${finding.count}`]),
          h.span([h.Class('finding-path')], [finding.path.join(' › ')]),
        ],
      ),
      finding.before === undefined
        ? h.empty
        : h.p([h.Class('finding-before')], [finding.before]),
      finding.after === undefined
        ? h.empty
        : h.p([h.Class('finding-after')], [finding.after]),
    ],
  )

const compareView = (
  comparisons: Array.NonEmptyReadonlyArray<ComparisonCase>,
  name: string,
  depth: number,
  h: HtmlBuilder<Message>,
): Html => {
  const result = nameOf(comparisons, name).run({ depth, states: STATES })
  return h.div(
    [],
    [
      h.header(
        [h.Class('lab-header')],
        [
          modeView('Compare', true, h),
          pickerView(
            'Comparison',
            Array.map(comparisons, comparison => comparison.name),
            name,
            comparison => Message.SelectedComparison({ comparison }),
            h,
          ),
          depthView(depth, h),
          h.span(
            [h.Class('lab-count')],
            [
              `${result.pairs} pairs · ${result.findings.length} differences · ${result.isComplete ? 'complete' : 'cut off'}`,
            ],
          ),
        ],
      ),
      h.ul(
        [h.Class('findings'), h.AriaLabel('Differences')],
        Array.map(result.findings, finding => findingView(finding, h)),
      ),
    ],
  )
}

export const makeLab = (
  cases: Array.NonEmptyReadonlyArray<Case>,
  comparisons: ReadonlyArray<ComparisonCase> = [],
) => {
  const maybeComparisons = Array.match(comparisons, {
    onEmpty: () => Option.none(),
    onNonEmpty: nonEmpty => Option.some(nonEmpty),
  })
  const init = (): Update.Return<Model, Message> => ({
    model: {
      mode: 'Explore',
      comparison: Option.match(maybeComparisons, {
        onNone: () => '',
        onSome: ([first]) => first.name,
      }),
      program: Array.headNonEmpty(cases).name,
      depth: 3,
      pruned: [],
      clicks: [],
    },
  })

  const update = (model: Model, message: Message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      SelectedMode: ({ mode }) => ({
        model: modifyFields(model, { mode: () => mode }),
      }),
      SelectedComparison: ({ comparison }) => ({
        model: modifyFields(model, { comparison: () => comparison }),
      }),
      SelectedProgram: ({ program }) => ({
        model: modifyFields(model, {
          program: () => program,
          pruned: () => [],
          clicks: () => [],
        }),
      }),
      ClickedShallower: () => ({
        model: modifyFields(model, { depth: depth => Math.max(0, depth - 1) }),
      }),
      ClickedDeeper: () => ({
        model: modifyFields(model, {
          depth: depth => Math.min(MAX_DEPTH, depth + 1),
        }),
      }),
      ClickedPrune: ({ key }) => ({
        model: modifyFields(model, {
          pruned: pruned => Array.append(pruned, key),
        }),
      }),
      ClickedReset: () => ({
        model: modifyFields(model, { pruned: () => [], clicks: () => [] }),
      }),
      InteractedWithState: ({ key, depth, message }) => ({
        model: modifyFields(model, {
          // The clicked state may sit at the depth limit, so go one deeper.
          depth: current => Math.min(MAX_DEPTH, Math.max(current, depth + 1)),
          clicks: clicks => Array.append(clicks, { key, message }),
        }),
      }),
    })

  const explored = (model: Model, h: HtmlBuilder<Message>): Html =>
    lazy(gridView, [
      cases,
      comparisons.length > 0,
      model.program,
      model.depth,
      JSON.stringify(model.pruned),
      model.clicks,
      h,
    ])

  const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
    title: model.mode === 'Compare' ? 'Compare versions' : model.program,
    body: h.div(
      [h.Class('lab')],
      [
        Option.match(maybeComparisons, {
          onNone: () => explored(model, h),
          onSome: nonEmpty =>
            model.mode === 'Compare'
              ? lazyCompare(compareView, [
                  nonEmpty,
                  model.comparison,
                  model.depth,
                  h,
                ])
              : explored(model, h),
        }),
      ],
    ),
  })

  return { Model, Message, init, update, view }
}
