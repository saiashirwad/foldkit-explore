import { click, expect, given, role, scene, text } from 'foldkit/scene'
import { expect as expectValue, test } from 'vitest'

import * as Signup from '../signup/main'
import { signupEnvironment } from '../signup/main.cases'
import { headingChanged, original } from '../signup/variants'
import { Message, makeCase, makeComparison, makeLab } from './lab'

const signup = makeCase(
  {
    name: 'Signup',
    Message: Signup.Message,
    start: Signup.init,
    update: Signup.update,
    view: Signup.view,
  },
  signupEnvironment,
)

const lab = makeLab([signup])

test('shows the states reached at the chosen depth', () => {
  scene(
    lab,
    given(lab.init().model),
    expect(role('region', { name: 'States' })).toExist(),
    expect(text('S1')).toExist(),
  )
})

test('pruning a state removes it', () => {
  scene(
    lab,
    given(lab.init().model),
    expect(text('S2')).toExist(),
    click(role('button', { name: 'Prune S2' })),
    expect(role('button', { name: 'Reset' })).toExist(),
    expect(text('Prune rule for your code')).toExist(),
  )
})

test('a click in a preview adds the state it leads to', () => {
  const limits = { depth: 1, states: 100 }
  const before = signup.run(limits, [])
  const [first] = before.cards
  const after = signup.run(limits, [
    {
      key: first?.key ?? '',
      message: Signup.Message.UpdatedUsername({ value: 'zed' }),
    },
  ])
  expectValue(after.total).toBe(before.total + 1)
})

test('reset clears pruned states and clicks', () => {
  const dirty = {
    ...lab.init().model,
    pruned: ['a'],
    clicks: [{ key: 'b', message: Signup.Message.ClickedNext() }],
  }
  expectValue(lab.update(dirty, Message.ClickedReset()).model).toMatchObject({
    pruned: [],
    clicks: [],
  })
})

test('compare mode lists the differences between two versions', () => {
  const comparing = makeLab(
    [signup],
    [makeComparison('Heading', original, headingChanged, signupEnvironment)],
  )
  scene(
    comparing,
    given({ ...comparing.init().model, mode: 'Compare', depth: 6 }),
    expect(role('list', { name: 'Differences' })).toExist(),
    expect(text('Screen differs')).toExist(),
  )
})
