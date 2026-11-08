import { Option } from 'effect'
import { click, expect, given, role, scene, text } from 'foldkit/scene'
import { expect as expectValue, test } from 'vitest'

import * as Signup from '../signup/main'
import { signupEnvironment } from '../signup/main.cases'
import { headingChanged, original } from '../signup/variants'
import { snapshotOf } from './baseline'
import {
  Message,
  makeBaselineComparison,
  makeCase,
  makeComparison,
  makeLab,
} from './lab'

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
  const before = signup.run(limits, [], false)
  const [first] = before.cards
  const after = signup.run(
    limits,
    [
      {
        key: first?.key ?? '',
        message: Signup.Message.UpdatedUsername({ value: 'zed' }),
      },
    ],
    false,
  )
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
  const [home] = signup.run({ depth: 1, states: 100 }, [], false).cards
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

test('merging look-alikes explores fewer states', () => {
  const limits = { depth: 3, states: 200 }
  const apart = signup.run(limits, [], false)
  const together = signup.run(limits, [], true)
  expectValue(together.total).toBeLessThan(apart.total)
  // Merging is a bigger saving at depth: the cap is hit later.
  expectValue(together.isComplete || !apart.isComplete).toBe(true)
})

test('find reaches a screen by its text, and the gallery lists unsent Messages', () => {
  const result = signup.find(
    'create account',
    { depth: 12, states: 3_000 },
    true,
  )
  expectValue(Option.isSome(result.found)).toBe(true)
  expectValue(
    Option.match(result.found, {
      onNone: () => 0,
      onSome: found => found.path.length,
    }),
  ).toBeLessThan(8)
  expectValue(
    signup.run({ depth: 1, states: 100 }, [], false).neverSent,
  ).toContain('SubmittedSignup')
})

test('a baseline comparison reports what changed since the snapshot', () => {
  const baseline = snapshotOf(original, signupEnvironment, {
    depth: 5,
    states: 3_000,
  })
  const same = makeBaselineComparison(
    'Same',
    original,
    signupEnvironment,
    baseline,
  )
  const changed = makeBaselineComparison(
    'Changed',
    headingChanged,
    signupEnvironment,
    baseline,
  )
  expectValue(same.run({ depth: 0, states: 0 }).findings).toEqual([])
  expectValue(
    changed
      .run({ depth: 0, states: 0 })
      .findings.map(({ finding }) => finding.kind),
  ).toContain('screen')
})
