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

test('selecting a card shows its moves in the sidebar, and pruning drops it', () => {
  scene(
    lab,
    given(lab.init().model),
    expect(role('complementary', { name: 'Selected state' })).toExist(),
    click(role('button', { name: 'Select S2' })),
    expect(text('S2')).toExist(),
    click(role('button', { name: 'Prune this state' })),
    expect(role('button', { name: 'Reset' })).toExist(),
    expect(text('Prune rule for your code')).toExist(),
  )
})

test('picking a move in the sidebar sends the selected card there', () => {
  scene(
    lab,
    given(lab.init().model),
    click(role('button', { name: 'user · typedAda to S3' })),
    expect(role('button', { name: 'Back to S1' })).toExist(),
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

test('a card lists where each move leads and can move there and back', () => {
  const [home] = signup.run({ depth: 1, states: 100 }, []).cards
  const [first] = home?.moves ?? []
  expectValue(first?.label).toBe('user · typedAda')
  const moved = lab.update(
    lab.init().model,
    Message.ClickedMove({ slot: home?.key ?? '', to: first?.to ?? '' }),
  ).model
  expectValue(moved.moved).toEqual({ [home?.key ?? '']: first?.to })
  expectValue(
    lab.update(moved, Message.ClickedHome({ slot: home?.key ?? '' })).model
      .moved,
  ).toEqual({})
})

test('an empty comparison says whether the search finished', () => {
  const comparing = makeLab(
    [signup],
    [makeComparison('Same', original, original, signupEnvironment)],
  )
  scene(
    comparing,
    given({ ...comparing.init().model, mode: 'Compare', depth: 1 }),
    expect(text('No differences found yet', { exact: false })).toExist(),
  )
})
