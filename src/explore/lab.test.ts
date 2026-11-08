import { click, expect, given, role, scene, text } from 'foldkit/scene'
import { test } from 'vitest'

import * as Signup from '../signup/main'
import { signupEnvironment } from '../signup/main.cases'
import { makeCase, makeLab } from './lab'

const lab = makeLab([
  makeCase(
    {
      name: 'Signup',
      start: Signup.init,
      update: Signup.update,
      view: Signup.view,
    },
    signupEnvironment,
  ),
])

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
    expect(role('button', { name: 'Restore pruned' })).toExist(),
  )
})
