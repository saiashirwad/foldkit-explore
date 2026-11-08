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

import { type Environment, type Limits, type Program, explore } from './explore'

// CASE

// One program and environment, with their types erased for the picker.
export type Case = Readonly<{
  name: string
  run: (limits: Limits) => Result
}>

type Result = Readonly<{
  cards: ReadonlyArray<Card>
  total: number
  isComplete: boolean
}>

type Card = Readonly<{
  key: string
  id: number
  via: string
  commands: string
  render: (h: HtmlBuilder<Message>) => Html
}>

const STATES = 200

export const makeCase = <ProgramModel, ProgramMessage, Input>(
  program: Program<ProgramModel, ProgramMessage, Input>,
  environment: Environment<ProgramModel, ProgramMessage, Input>,
): Case => {
  const view = defineView<ProgramModel, ProgramMessage>(program.view)
  return {
    name: program.name,
    run: limits => {
      const graph = explore(program, environment, limits)
      return {
        total: graph.nodes.length,
        isComplete: graph.isComplete,
        cards: Array.map(
          Array.filter(graph.nodes, node => node.shown),
          node => ({
            key: node.key,
            id: node.id,
            via: node.via.join(' · '),
            commands: Array.map(node.pending, command => command.name).join(
              ', ',
            ),
            render: (h: HtmlBuilder<Message>) =>
              h.submodel({
                slotId: `state-${node.id}`,
                model: node.model,
                view,
                toParentMessage: () => Message.IgnoredPreview(),
              }),
          }),
        ),
      }
    },
  }
}

// MODEL

export const Model = Schema.Struct({
  program: Schema.String,
  depth: Schema.Number,
  pruned: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

const MAX_DEPTH = 8

// MESSAGE

export const Message = defineMessageUnion({
  SelectedProgram: { program: Schema.String },
  ClickedShallower: {},
  ClickedDeeper: {},
  ClickedPrune: { key: Schema.String },
  ClickedUnprune: {},
  IgnoredPreview: {},
})
export type Message = typeof Message.Type

// VIEW

const lazy = createLazy()

const cardView = (card: Card, h: HtmlBuilder<Message>): Html =>
  h.article(
    [h.Class('state')],
    [
      h.div(
        [h.Class('state-head')],
        [
          h.span([h.Class('state-id')], [`S${card.id + 1}`]),
          h.span([h.Class('state-via')], [card.via]),
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

const caseOf = (
  cases: Array.NonEmptyReadonlyArray<Case>,
  program: string,
): Case =>
  Option.getOrElse(
    Array.findFirst(cases, ({ name }) => name === program),
    () => Array.headNonEmpty(cases),
  )

const gridView = (
  cases: Array.NonEmptyReadonlyArray<Case>,
  program: string,
  depth: number,
  pruned: string,
  h: HtmlBuilder<Message>,
): Html => {
  const keys: ReadonlyArray<string> = JSON.parse(pruned)
  const current = caseOf(cases, program)
  const result = current.run({
    depth,
    states: STATES,
    exclude: new Set(keys),
  })
  return h.div(
    [],
    [
      h.header(
        [h.Class('lab-header')],
        [
          h.select(
            [
              h.AriaLabel('Program'),
              h.OnChange(name => Message.SelectedProgram({ program: name })),
            ],
            Array.map(cases, ({ name }) =>
              h.option([h.Value(name), h.Selected(name === program)], [name]),
            ),
          ),
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
          ),
          h.span([h.Class('lab-count')], [countView(result, keys.length)]),
          keys.length > 0
            ? h.button(
                [h.Class('lab-quiet'), h.OnClick(Message.ClickedUnprune())],
                ['Restore pruned'],
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

export const makeLab = (cases: Array.NonEmptyReadonlyArray<Case>) => {
  const init = (): Update.Return<Model, Message> => ({
    model: {
      program: Array.headNonEmpty(cases).name,
      depth: 3,
      pruned: [],
    },
  })

  const update = (model: Model, message: Message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      SelectedProgram: ({ program }) => ({
        model: { program, depth: model.depth, pruned: [] },
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
      ClickedUnprune: () => ({
        model: modifyFields(model, { pruned: () => [] }),
      }),
      IgnoredPreview: () => ({ model }),
    })

  const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
    title: caseOf(cases, model.program).name,
    body: h.div(
      [h.Class('lab')],
      [
        lazy(gridView, [
          cases,
          model.program,
          model.depth,
          JSON.stringify(model.pruned),
          h,
        ]),
      ],
    ),
  })

  return { Model, Message, init, update, view }
}
