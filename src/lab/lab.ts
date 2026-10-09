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

import { Address, type Atlas, Search, type Step } from './atlas'

// MODEL

const Pin = Schema.Struct({ slot: Schema.String, address: Address })

export const Model = Schema.Struct({
  program: Schema.String,
  where: Schema.Record(Schema.String, Schema.String),
  depth: Schema.Number,
  search: Search,
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

const fresh = (program: string, search: Search = 'breadth'): Model => ({
  program,
  where: {},
  depth: 1,
  search,
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
          h.Disabled(atlas.reach(model.depth, model.search).isComplete),
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
    Array.map(
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
  )

const nextView = (
  slot: string,
  current: string,
  steps: ReadonlyArray<Step>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const moves = Array.filter(steps, step =>
    Array.isReadonlyArrayEmpty(optionsOf(step)),
  )
  const answers = Array.filter(steps, step =>
    Array.isReadonlyArrayNonEmpty(optionsOf(step)),
  )
  return [
    ...(Array.isReadonlyArrayNonEmpty(moves)
      ? [
          h.div(
            [h.Class('next-group')],
            [
              h.div([h.Class('next-title')], ['User actions']),
              ...Array.map(moves, step =>
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
                ),
              ),
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
// parts are tokens. Objects holding only a tag fit on one line.
const modelView = (value: unknown, h: HtmlBuilder<Message>): Html => {
  const parts = JSON.stringify(value, null, 2)
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
  depth: number,
  search: Search,
  h: HtmlBuilder<Message>,
): Html => {
  const failures = atlas.check(depth)
  const { isComplete } = atlas.reach(depth, search)
  const trace = atlas.trace(card.state)
  const distance = trace.length - 1
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
        Array.map(atlas.pending(card.state), ({ name, args }) =>
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
        'Click one to step this preview there.',
        nextView(card.slot, card.state, atlas.successors(card.state), h),
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
                      [`${atlas.pending(state).length} in flight`],
                    ),
                  ],
                ),
              ),
            ],
            h,
          )
        : h.empty,
      inspectorDetails(
        'Model',
        '',
        [modelView(atlas.encode(card.state), h)],
        h,
      ),
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
              `Depth ${depth}; exploration threshold ${atlas.budget} states; ${isComplete ? 'complete within declared environment' : 'incomplete'}.`,
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
        ...Array.map(
          atlas.groups(atlas.reach(model.depth, model.search).states),
          group =>
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
      SelectedProgram: ({ program }) => ({
        model: fresh(program, model.search),
      }),
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
      SelectedSearch: ({ search }) => ({
        model: modifyFields(model, { search: () => search, limit: () => PAGE }),
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
                `${cards.length} groups · ${atlas.reach(model.depth, model.search).states.length} states · ${atlas.reach(model.depth, model.search).isComplete ? 'complete' : 'incomplete'}`,
              ],
            ),
            searchView(model, h),
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
                onSome: card =>
                  inspectorView(atlas, card, model.depth, model.search, h),
              }),
            ],
          ),
        ],
      ),
    }
  }

  return { Model, Message, init, update, view }
}
