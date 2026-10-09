import { Array, Option } from 'effect'
import * as Scene from 'foldkit/scene'
import { expect, test } from 'vitest'

import * as Signup from '../signup/main'
import { SignupCases } from '../signup/main.cases'
import { properties } from '../signup/properties'
import { make } from './atlas'
import { Message, makeLab } from './lab'

test('grouped gallery renders through Foldkit and interactions use selected execution', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule: 'any',
    properties,
  })
  const lab = makeLab([atlas])
  const model = lab.update(
    lab.update(lab.init().model, Message.ClickedDeeper()).model,
    Message.ClickedDeeper(),
  ).model
  Scene.scene(
    lab,
    Scene.given(model),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain('groups')
      expect(Scene.textContent(simulation.html)).toContain('incomplete')
      expect(Scene.textContent(simulation.html)).toContain(
        'any pending Command',
      )
    }),
  )
  const group = Option.getOrThrow(
    Array.findFirst(
      atlas.groups(atlas.reach(3).states),
      group => group.states.length > 1,
    ),
  )
  const selected = Option.getOrThrow(Array.last(group.states))
  const slot = atlas.key(group.home)
  const chosen = lab.update(
    model,
    Message.ClickedStep({ slot, state: selected }),
  ).model
  const changed = lab.update(
    chosen,
    Message.InteractedWithCase({
      slot,
      state: selected,
      message: Signup.Message.UpdatedUsername({ value: 'grace' }),
    }),
  ).model
  const destination = Option.getOrThrow(
    atlas.resolve(changed.positions[slot] ?? []),
  )
  const expected = Option.getOrThrow(
    atlas.send(selected, Signup.Message.UpdatedUsername({ value: 'grace' })),
  )
  expect(destination).toBe(expected)
})

test('filters pinned cards by their displayed state', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule: 'any',
  })
  const lab = makeLab([atlas])
  const home = Option.getOrThrow(
    Array.findFirst(atlas.reach(0).states, state =>
      atlas
        .trace(state)
        .some(step =>
          step.decisions.some(decision => decision.option === 'home'),
        ),
    ),
  )
  const pinned = lab.update(
    lab.init().model,
    Message.ClickedPin({ state: home }),
  ).model
  const pricingOnly = lab.update(
    pinned,
    Message.SelectedFilter({ fixture: 'arrivedFrom', option: 'pricing' }),
  ).model
  Scene.scene(
    lab,
    Scene.given(pricingOnly),
    Scene.tap(simulation => {
      const pin = Option.getOrThrow(Array.head(pinned.pins))
      expect(
        Scene.findAll(simulation.html, 'article.case').some(
          card => card.key === pin.slot,
        ),
      ).toBe(false)
    }),
  )
})

test('filters moved cards by their displayed response trace', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule: 'any',
  })
  const lab = makeLab([atlas])
  const home = Option.getOrThrow(
    Array.findFirst(atlas.reach(0).states, state =>
      atlas
        .trace(state)
        .some(step =>
          step.decisions.some(decision => decision.option === 'home'),
        ),
    ),
  )

  const checking = Option.getOrThrow(
    atlas.send(home, Signup.Message.UpdatedUsername({ value: 'ada' })),
  )
  const free = Option.getOrThrow(
    Array.findFirst(
      atlas.successors(checking),
      step => step.kind === 'Answer' && step.label.endsWith(' free'),
    ),
  ).to
  const taken = Option.getOrThrow(
    Array.findFirst(
      atlas.successors(checking),
      step => step.kind === 'Answer' && step.label.endsWith(' taken'),
    ),
  ).to
  const deep = lab.update(lab.init().model, Message.ClickedDeeper()).model
  const slot = atlas.key(free)
  const moved = lab.update(
    deep,
    Message.ClickedStep({ slot, state: taken }),
  ).model
  const freeOnly = lab.update(
    moved,
    Message.SelectedFilter({ fixture: 'name', option: 'free' }),
  ).model
  Scene.scene(
    lab,
    Scene.given(freeOnly),
    Scene.tap(simulation => {
      expect(
        Scene.findAll(simulation.html, 'article.case').some(
          card => card.key === slot,
        ),
      ).toBe(false)
    }),
  )
})

test('keeps a moved card and its stable slot when only its displayed response matches', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule: 'any',
  })
  const lab = makeLab([atlas])
  const home = Option.getOrThrow(Array.head(atlas.reach(0).states))
  const slot = atlas.key(home)
  const checking = Option.getOrThrow(
    atlas.send(home, Signup.Message.UpdatedUsername({ value: 'ada' })),
  )
  const free = Option.getOrThrow(
    Array.findFirst(
      atlas.successors(checking),
      step => step.kind === 'Answer' && step.label.endsWith(' free'),
    ),
  ).to
  const moved = lab.update(
    lab.init().model,
    Message.ClickedStep({ slot, state: free }),
  ).model
  const filtered = lab.update(
    moved,
    Message.SelectedFilter({ fixture: 'name', option: 'free' }),
  ).model
  const cleared = lab.update(
    filtered,
    Message.ClearedFilter({ fixture: 'name' }),
  ).model
  Array.forEach([filtered, cleared], model => {
    Scene.scene(
      lab,
      Scene.given(model),
      Scene.tap(simulation => {
        const card = Scene.findAll(simulation.html, 'article.case').find(
          card => card.key === slot,
        )
        expect(card).toBeDefined()
        if (card !== undefined) {
          expect(Scene.textContent(card)).toContain('Available')
          expect(Option.isSome(Scene.getByDisplayValue('ada')(card))).toBe(true)
        }
      }),
    )
    expect(Option.getOrThrow(atlas.resolve(model.positions[slot] ?? []))).toBe(
      free,
    )
  })
})

test('an unmoved group retains its slot when the filter selects a different member', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
  })
  const lab = makeLab([atlas])
  const starts = atlas.reach(0).states
  const home = Option.getOrThrow(Array.head(starts))
  const pricing = Option.getOrThrow(Array.last(starts))
  const filtered = lab.update(
    lab.init().model,
    Message.SelectedFilter({ fixture: 'arrivedFrom', option: 'pricing' }),
  ).model
  Scene.scene(
    lab,
    Scene.given(filtered),
    Scene.tap(simulation => {
      const card = Scene.findAll(simulation.html, 'article.case').find(
        card => card.key === atlas.key(home),
      )
      expect(card).toBeDefined()
      if (card !== undefined) {
        expect(Scene.textContent(card)).not.toContain(pricing)
        expect(Scene.textContent(card)).toContain('Inspect')
        const inspector = Option.getOrThrow(
          Scene.find(simulation.html, 'aside.inspector'),
        )
        expect(Scene.textContent(inspector)).toContain(pricing)
      }
    }),
  )
})

test('previews contain only the app and Inspect selects the slot for replies', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule: 'any',
  })
  const lab = makeLab([atlas])
  const group = Option.getOrThrow(
    Array.findFirst(
      atlas.groups(atlas.reach(1).states),
      group => atlas.pending(group.home).length > 0,
    ),
  )
  const index = atlas
    .groups(atlas.reach(1).states)
    .findIndex(candidate => candidate.home === group.home)
  const card = Scene.nth(index)(Scene.all.selector('article.case'))
  const inspect = Scene.within(card, Scene.role('button', { name: 'Inspect' }))
  const answer = Option.getOrThrow(
    Array.findFirst(
      atlas.successors(group.home),
      step => step.kind === 'Answer' && step.label.endsWith(' free'),
    ),
  )
  Scene.scene(
    lab,
    Scene.given(lab.init().model),
    Scene.tap(simulation => {
      Array.forEach(
        Scene.findAll(simulation.html, '.case-preview'),
        preview => {
          expect(Scene.textContent(preview)).not.toMatch(
            /executions|CheckUsername|Inspect|S\d+/,
          )
          expect(Scene.findAll(preview, '.case-tools')).toEqual([])
        },
      )
      expect(Scene.findAll(simulation.html, '.case-head')).toEqual([])
      expect(Scene.findAll(simulation.html, '.case-answers')).toEqual([])
    }),
    Scene.click(inspect),
    Scene.tap(simulation => {
      expect(
        Scene.textContent(
          Option.getOrThrow(
            Scene.find(simulation.html, '.inspector-head strong'),
          ),
        ),
      ).toBe(group.home)
    }),
    Scene.click(
      Scene.within(
        Scene.selector('aside.inspector'),
        Scene.role('button', { name: `${answer.label} ${answer.to}` }),
      ),
    ),
    Scene.tap(simulation => {
      expect(
        Scene.textContent(
          Option.getOrThrow(
            Scene.find(simulation.html, '.inspector-head strong'),
          ),
        ),
      ).toBe(answer.to)
      expect(
        Scene.textContent(Option.getOrThrow(card(simulation.html))),
      ).toContain('Available')
    }),
    Scene.type(Scene.within(card, Scene.label('Username')), 'grace'),
    Scene.tap(simulation => {
      const preview = Option.getOrThrow(card(simulation.html))
      expect(Option.isSome(Scene.getByDisplayValue('grace')(preview))).toBe(
        true,
      )
      expect(Scene.textContent(preview)).toContain('Checking')
    }),
  )
})

test('the search control orders the gallery and survives a program switch', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule: 'any',
  })
  const lab = makeLab([atlas])
  Scene.scene(
    lab,
    Scene.given(lab.init().model),
    Scene.click(Scene.role('button', { name: 'DFS' })),
    Scene.tap(simulation => {
      expect(
        Array.map(
          Scene.findAll(simulation.html, '.lab-search [aria-pressed="true"]'),
          Scene.textContent,
        ),
      ).toEqual(['DFS'])
    }),
  )
  const model = lab.update(
    lab.update(lab.init().model, Message.SelectedSearch({ search: 'random' }))
      .model,
    Message.SelectedProgram({ program: 'Signup' }),
  ).model
  expect(model.search).toBe('random')
  expect(lab.update(model, Message.ClickedReset()).model.search).toBe('breadth')
})

test('property evidence names BFS and depth even with a random gallery', () => {
  const atlas = make({
    name: 'Signup',
    Model: Signup.Model,
    Message: Signup.Message,
    update: Signup.update,
    view: Signup.view,
    cases: SignupCases,
    schedule: 'any',
    properties,
  })
  const lab = makeLab([atlas])
  Scene.scene(
    lab,
    Scene.given(lab.init().model),
    Scene.click(Scene.role('button', { name: 'Random' })),
    Scene.tap(simulation => {
      const inspector = Option.getOrThrow(
        Scene.find(simulation.html, 'aside.inspector'),
      )
      expect(Scene.textContent(inspector)).toContain('No violations found')
      expect(Scene.textContent(inspector)).toContain(
        'Breadth-first checks through depth 1, independently of the gallery search.',
      )
      expect(Scene.textContent(inspector)).toContain(
        'not all possible executions',
      )
    }),
  )
})
