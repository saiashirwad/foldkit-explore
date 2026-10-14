import { Option, Schema } from 'effect'
import { CustomElement } from 'foldkit'
import type { HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'
import { expect, test } from 'vitest'

import { Availability, Message, init, view } from '../signup/main'
import { canonical } from './canonical'
import { inspect } from './interactions'

const PropertyElement = CustomElement.define({
  tag: 'property-element',
  properties: { selection: Schema.Option(Schema.Unknown) },
  events: {},
})

test('keeps DOM property values without renderer-private symbol metadata', () => {
  const html = inspect(
    (_model: number, h) => h.div([h.InnerHTML('<strong>Ready</strong>')]),
    0,
    [],
  )
  const custom = inspect(
    (_model: number, h) => {
      const element = PropertyElement.withMessage(h)
      return element([element.Selection(Option.some(undefined))])
    },
    0,
    [],
  )

  expect(html.screen.properties).toEqual({
    innerHTML: '<strong>Ready</strong>',
  })
  expect(custom.screen.properties).toEqual({
    selection: Option.some(undefined),
  })
  expect(Object.getOwnPropertySymbols(html.screen.properties)).toEqual([])
  expect(Object.getOwnPropertySymbols(custom.screen.properties)).toEqual([])
  expect(() => canonical(html.screen)).not.toThrow()
  expect(() => canonical(custom.screen)).not.toThrow()
})

test('discovers signup inputs and respects disabled submit', () => {
  const result = inspect(view, init('Free').model, [
    { label: 'Username', values: ['ada', 'grace'] },
  ])
  expect(result.interactions.map(action => action.message)).toEqual([
    Message.UpdatedUsername({ value: 'ada' }),
    Message.UpdatedUsername({ value: 'grace' }),
  ])
})

test('discovers enabled form submission and buttons from the view', () => {
  const result = inspect(
    view,
    modifyFields(init('Free').model, {
      availability: () => Availability.Free(),
    }),
    [],
  )
  expect(result.interactions.map(action => action.message)).toContainEqual(
    Message.ClickedNext(),
  )
})

test('observes changed headings independently of action identity', () => {
  const headingView = (heading: string, h: HtmlBuilder<string>) =>
    h.div(
      [],
      [h.h1([], [heading]), h.button([h.OnClick('continued')], ['Continue'])],
    )
  const before = inspect(headingView, 'Welcome', [])
  const after = inspect(headingView, 'Hello', [])

  expect(before.screen).toMatchObject({
    tag: 'div',
    children: [{ tag: 'h1' }, { tag: 'button' }],
  })
  expect(canonical(before.screen)).not.toBe(canonical(after.screen))
  expect(before.interactions).toEqual(after.interactions)
  expect(before.interactions).toEqual([
    {
      key: canonical(['Move', 'continued']),
      label: 'click Continue',
      message: 'continued',
    },
  ])
})

test('keeps action keys through control reordering and copy changes', () => {
  const choicesView = (
    choices: ReadonlyArray<Readonly<{ label: string; message: string }>>,
    h: HtmlBuilder<string>,
  ) =>
    h.div(
      [],
      choices.map(choice =>
        h.button([h.OnClick(choice.message)], [choice.label]),
      ),
    )
  const before = inspect(
    choicesView,
    [
      { label: 'First', message: 'selected-first' },
      { label: 'Second', message: 'selected-second' },
    ],
    [],
  )
  const after = inspect(
    choicesView,
    [
      { label: 'Pick B', message: 'selected-second' },
      { label: 'Pick A', message: 'selected-first' },
    ],
    [],
  )

  expect(before.interactions.map(action => action.key).sort()).toEqual(
    after.interactions.map(action => action.key).sort(),
  )
  expect(before.interactions.map(action => action.label)).not.toEqual(
    after.interactions.map(action => action.label),
  )
})

test('does not identify distinct Messages by equal readable labels', () => {
  const result = inspect(
    (_model: number, h: HtmlBuilder<string>) =>
      h.div(
        [],
        [
          h.button([h.OnClick('selected-first')], ['Choose']),
          h.button([h.OnClick('selected-second')], ['Choose']),
        ],
      ),
    0,
    [],
  )

  expect(result.interactions.map(action => action.label)).toEqual([
    'click Choose',
    'click Choose',
  ])
  expect(new Set(result.interactions.map(action => action.key)).size).toBe(2)
})

test('uses the program Message encoder to construct matching keys', () => {
  const result = inspect(
    (_model: number, h: HtmlBuilder<number>) =>
      h.button([h.OnClick(3)], ['Choose']),
    0,
    [],
    message => ({ selected: String(message) }),
  )

  expect(result.interactions).toEqual([
    {
      key: canonical(['Move', { selected: '3' }]),
      label: 'click Choose',
      message: 3,
    },
  ])
})

test('preserves Option payloads in action keys', () => {
  const result = inspect(
    (_model: number, h: HtmlBuilder<Option.Option<string>>) =>
      h.div(
        [],
        [
          h.button([h.OnClick(Option.none())], ['Clear']),
          h.button([h.OnClick(Option.some('ada'))], ['Choose']),
        ],
      ),
    0,
    [],
    Schema.encodeSync(Schema.Option(Schema.String)),
  )

  expect(new Set(result.interactions.map(action => action.key)).size).toBe(2)
})

test('rejects emitted Messages that do not satisfy the program schema', () => {
  expect(() =>
    inspect(
      (_model: number, h: HtmlBuilder<unknown>) =>
        h.button(
          [h.OnClick({ _tag: 'UpdatedUsername', value: 3 })],
          ['Choose'],
        ),
      0,
      [],
      Schema.encodeUnknownSync(Message),
    ),
  ).toThrow('Invalid Message from interaction "click Choose"')
})

test('rejects emitted Messages with unsupported values', () => {
  expect(() =>
    inspect(
      (_model: number, h: HtmlBuilder<unknown>) =>
        h.button([h.OnClick({ callback: () => 'selected' })], ['Choose']),
      0,
      [],
    ),
  ).toThrow('Invalid Message from interaction "click Choose"')
})

test('rejects configured input domains on unsupported controls', () => {
  expect(() =>
    inspect(
      (_model: number, h: HtmlBuilder<string>) =>
        h.select(
          [h.AriaLabel('Plan'), h.OnChange(value => value)],
          [h.option([h.Value('Free')], ['Free'])],
        ),
      0,
      [{ label: 'Plan', values: ['Free'] }],
    ),
  ).toThrow(
    'Unsupported input "Plan": configured values require an editable textbox.',
  )
})

test('does not silently omit enabled buttons with missing handlers', () => {
  expect(() =>
    inspect(
      (_model: number, h: HtmlBuilder<string>) => h.button([], ['Choose']),
      0,
      [],
    ),
  ).toThrow('neither it nor any ancestor has a click handler')
})

test('does not type into disabled or readonly fields', () => {
  const result = inspect(
    (_model: number, h) =>
      h.div(
        [],
        [
          h.input([
            h.AriaLabel('Disabled'),
            h.Disabled(true),
            h.OnInput(value => value),
          ]),
          h.input([
            h.AriaLabel('Readonly'),
            h.Readonly(true),
            h.OnInput(value => value),
          ]),
        ],
      ),
    0,
    [
      { label: 'Disabled', values: ['ada'] },
      { label: 'Readonly', values: ['ada'] },
    ],
  )
  expect(result.interactions).toEqual([])
})

test('rejects a click that emits both click and submit Messages', () => {
  expect(() =>
    inspect(
      (_model: number, h) =>
        h.form(
          [h.OnSubmit('submitted')],
          [h.button([h.Type('submit'), h.OnClick('clicked')], ['Send'])],
        ),
      0,
      [],
    ),
  ).toThrow(
    'Unsupported interaction "click Send": emitted 2 Messages; only single-message interactions are supported.',
  )
})
