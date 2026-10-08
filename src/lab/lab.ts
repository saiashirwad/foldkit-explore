import { Array, Option, Record, Schema, pipe } from 'effect'
import type { Update } from 'foldkit'
import {
  type Document,
  type Html,
  type HtmlBuilder,
  createKeyedLazy,
} from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Address, type Atlas, type Step } from './atlas'

// MODEL

const Pin = Schema.Struct({ slot: Schema.String, address: Address })

export const Model = Schema.Struct({
  program: Schema.String,
  where: Schema.Record(Schema.String, Schema.String),
  depth: Schema.Number,
  limit: Schema.Number,
  positions: Schema.Record(Schema.String, Address),
  pins: Schema.Array(Pin),
  maybeSelected: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

type Card = Readonly<{
  slot: string
  home: string
  state: string
  states: ReadonlyArray<string>
}>

const PAGE = 48

const fresh = (program: string): Model => ({
  program,
  where: {},
  depth: 1,
  limit: PAGE,
  positions: {},
  pins: [],
  maybeSelected: Option.none(),
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
  SelectedProgram: { program: Schema.String },
  SelectedFilter: { fixture: Schema.String, option: Schema.String },
  ClearedFilter: { fixture: Schema.String },
  ClickedDeeper: {},
  ClickedShallower: {},
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
})
export type Message = typeof Message.Type

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

const depthView = (model: Model, atlas: Atlas, h: HtmlBuilder<Message>): Html =>
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
          h.Disabled(atlas.reach(model.depth).isComplete),
          h.OnClick(Message.ClickedDeeper()),
        ],
        ['+'],
      ),
    ],
  )

// NOTE: Arguments are primitives so unchanged previews keep their lazy slot.
const caseView = (
  atlas: Atlas,
  slot: string,
  state: string,
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
          atlas.render(state, slot, h, caseMessage =>
            Message.InteractedWithCase({ slot, state, message: caseMessage }),
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
        h.p([h.Class('lab-empty')], ['No states match these filters.']),
      ],
      onNonEmpty: nonEmpty => [
        ...Array.map(Array.take(nonEmpty, model.limit), card =>
          lazyCase(card.slot, caseView, [
            atlas,
            card.slot,
            card.state,
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

const stepRow = (
  slot: string,
  step: Step,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Class(isCurrent ? 'row is-current' : 'row'),
      h.OnClick(Message.ClickedStep({ slot, state: step.to })),
    ],
    [
      h.span([h.Class('row-label')], [step.label]),
      h.span([h.Class('row-state')], [step.to]),
    ],
  )

const inspectorSection = (
  title: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.isReadonlyArrayEmpty(children)
    ? h.empty
    : h.section(
        [h.Class('inspector-section')],
        [h.h4([], [title]), ...children],
      )

const inspectorView = (
  atlas: Atlas,
  card: Card,
  depth: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.aside(
    [h.Class('inspector'), h.AriaLabel('Selected state')],
    [
      h.header(
        [h.Class('inspector-head')],
        [
          h.strong([], [card.state]),
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
      h.details(
        [],
        [
          h.summary(
            [],
            [`${card.states.length} execution states in this group`],
          ),
          ...Array.map(card.states, state =>
            h.button(
              [
                h.Class(state === card.state ? 'row is-current' : 'row'),
                h.OnClick(Message.ClickedStep({ slot: card.slot, state })),
              ],
              [state, ` · ${atlas.pending(state).length} pending`],
            ),
          ),
        ],
      ),
      h.details(
        [],
        [
          h.summary([], ['Exploration scope']),
          h.p(
            [],
            [
              `Replies: ${atlas.schedule === 'any' ? 'any pending Command' : 'oldest pending Command'}. Response fixtures choose independently on each answer.`,
            ],
          ),
          h.p(
            [],
            [
              `Depth ${depth}; exploration threshold ${atlas.budget} states; ${atlas.reach(depth).isComplete ? 'complete within declared environment' : 'incomplete'}.`,
            ],
          ),
          h.p([], [atlas.grouping]),
          h.p(
            [],
            [
              'View-driven moves cover enabled buttons and configured text inputs only. Other programs use declared moves.',
            ],
          ),
        ],
      ),
      h.details(
        [],
        [
          h.summary(
            [],
            [`Properties · ${atlas.check(depth).length} violations`],
          ),
          h.p(
            [],
            [
              'Checks cover reached states and transitions within the selected depth, not all possible executions.',
            ],
          ),
          ...Array.map(atlas.propertyNames, name => h.p([], [name])),
          ...Array.map(atlas.check(depth), failure =>
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
        ],
      ),
      inspectorSection(
        'Trace',
        Array.map(atlas.trace(card.state), step =>
          stepRow(card.slot, step, step.to === card.state, h),
        ),
        h,
      ),
      inspectorSection(
        'Pending',
        Array.map(atlas.pending(card.state), ({ name, args }) =>
          h.code([h.Class('inspector-command')], [`${name} ${args}`]),
        ),
        h,
      ),
      inspectorSection(
        'Next',
        Array.map(atlas.successors(card.state), step =>
          stepRow(card.slot, step, false, h),
        ),
        h,
      ),
      h.details(
        [],
        [
          h.summary([], ['Model']),
          h.pre([], [JSON.stringify(atlas.encode(card.state), null, 2)]),
        ],
      ),
    ],
  )

// LAB

export const makeLab = (atlases: Array.NonEmptyReadonlyArray<Atlas>) => {
  const atlasOf = (model: Model): Atlas =>
    Option.getOrElse(
      Array.findFirst(atlases, atlas => atlas.name === model.program),
      () => Array.headNonEmpty(atlases),
    )

  const cardsOf = (model: Model, atlas: Atlas): ReadonlyArray<Card> => {
    const place = (
      slot: string,
      home: string,
      states: ReadonlyArray<string>,
    ): Card => ({
      slot,
      home,
      states,
      state: pipe(
        Record.get(model.positions, slot),
        Option.flatMap(atlas.resolve),
        Option.getOrElse(() =>
          Option.getOrElse(Array.head(states), () => home),
        ),
      ),
    })
    return Array.filter(
      [
        ...Array.getSomes(
          Array.map(model.pins, pin =>
            Option.map(atlas.resolve(pin.address), home =>
              place(pin.slot, home, [home]),
            ),
          ),
        ),
        ...Array.map(atlas.groups(atlas.reach(model.depth).states), group =>
          place(
            atlas.key(group.home),
            group.home,
            Array.filter(group.states, state =>
              isMatching(atlas.trace(state), model.where),
            ),
          ),
        ),
      ],
      card => isMatching(atlas.trace(card.state), model.where),
    )
  }

  // INIT

  const init = (): Update.Return<Model, Message> => ({
    model: fresh(Array.headNonEmpty(atlases).name),
  })

  // UPDATE

  const moveTo = (model: Model, slot: string, state: string): Model =>
    modifyFields(model, {
      positions: positions =>
        Record.set(positions, slot, atlasOf(model).address(state)),
      maybeSelected: () => Option.some(slot),
    })

  const update = (model: Model, message: Message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      SelectedProgram: ({ program }) => ({ model: fresh(program) }),
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
      ClickedDeeper: () => ({
        model: modifyFields(model, { depth: depth => depth + 1 }),
      }),
      ClickedShallower: () => ({
        model: modifyFields(model, { depth: depth => Math.max(0, depth - 1) }),
      }),
      ClickedShowMore: () => ({
        model: modifyFields(model, { limit: limit => limit + PAGE }),
      }),
      ClickedReset: () => ({ model: fresh(model.program) }),
      ClickedCase: ({ slot }) => ({
        model: modifyFields(model, { maybeSelected: () => Option.some(slot) }),
      }),
      InteractedWithCase: ({ slot, state, message: caseMessage }) =>
        Option.match(atlasOf(model).send(state, caseMessage), {
          onNone: () => ({ model }),
          onSome: next => ({ model: moveTo(model, slot, next) }),
        }),
      ClickedStep: ({ slot, state }) => ({ model: moveTo(model, slot, state) }),
      ClickedPin: ({ state }) => {
        const slot = `pin ${model.pins.length + 1}`
        return {
          model: modifyFields(model, {
            pins: pins =>
              Array.append(pins, {
                slot,
                address: atlasOf(model).address(state),
              }),
            maybeSelected: () => Option.some(slot),
          }),
        }
      },
      ClickedRestore: ({ slot }) => ({
        model: modifyFields(model, {
          positions: positions => Record.remove(positions, slot),
        }),
      }),
    })

  // VIEW

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
    atlas: Atlas,
    cards: ReadonlyArray<Card>,
    h: HtmlBuilder<Message>,
  ): Html =>
    h.header(
      [h.Class('lab-header')],
      [
        programView(model, h),
        h.div(
          [h.Class('lab-filters')],
          Array.map(atlas.fixtures(), ({ name, options }) =>
            filterView(model, name, options, h),
          ),
        ),
        h.div(
          [h.Class('lab-header-end')],
          [
            h.span(
              [h.Class('lab-count')],
              [
                `${cards.length} groups · ${atlas.reach(model.depth).states.length} states · ${atlas.reach(model.depth).isComplete ? 'complete' : 'incomplete'}`,
              ],
            ),
            depthView(model, atlas, h),
            h.button(
              [h.Class('lab-quiet'), h.OnClick(Message.ClickedReset())],
              ['Reset'],
            ),
          ],
        ),
      ],
    )

  const view = (model: Model, h: HtmlBuilder<Message>): Document => {
    const atlas = atlasOf(model)
    const cards = cardsOf(model, atlas)
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
          headerView(model, atlas, cards, h),
          h.main(
            [h.Class('lab-workspace')],
            [
              gridView(model, atlas, cards, maybeSelected, h),
              Option.match(maybeSelected, {
                onNone: () => h.empty,
                onSome: card => inspectorView(atlas, card, model.depth, h),
              }),
            ],
          ),
        ],
      ),
    }
  }

  return { Model, Message, init, update, view }
}
