import { expect, test } from 'vitest'

import { Availability, Message, init, view } from '../signup/main'
import { inspect } from './interactions'

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
    { ...init('Free').model, availability: Availability.Free() },
    [],
  )
  expect(result.interactions.map(action => action.message)).toContainEqual(
    Message.ClickedNext(),
  )
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
