import { Array, Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import * as Scene from 'foldkit/scene'
import { expect, test, vi } from 'vitest'

import { signupEnvironment } from '../programs'
import * as Signup from '../signup/main'
import { properties } from '../signup/properties'
import { analysisScene, dispatch, settle } from './analysis-test'
import { answer, describe, make, pendingRequests, send } from './atlas'
import { canonical } from './canonical'
import { fixture } from './fixture'
import { Message, makeLab } from './lab'

test.each([
  { value: 0n, expected: '0n' },
  { value: undefined, expected: 'undefined' },
])(
  'Explore can inspect and describe a $expected Model',
  async ({ value, expected }) => {
    const atlas = make(
      {
        name: 'Data Model',
        Model: Schema.Unknown,
        Message: Schema.Number,
        start: () => ({ model: value }),
        update: model => ({ model }),
        view: (_model, h) => h.p([], ['Preview']),
      },
      { *starts() {} },
    )
    const lab = makeLab([atlas])
    await analysisScene(
      lab,
      await settle(lab, lab.init()),
      Scene.tap(simulation => {
        const model = Option.getOrThrow(
          Scene.find(simulation.html, '.inspector-model'),
        )
        expect(Scene.textContent(model)).toContain(expected)
      }),
    )
    expect(describe(atlas, 0)).toContain(expected)
  },
)

test.each([false, true])(
  'the inspector checks only declared properties (%s)',
  async hasProperties => {
    const check = vi.fn()
    const atlas = make(
      {
        name: 'Counter',
        Model: Schema.Number,
        Message: Schema.Number,
        start: () => ({ model: 0 }),
        update: model => ({ model }),
        view: (_model, h) => h.p([], ['Preview']),
      },
      { *starts() {} },
      {
        properties: hasProperties
          ? [
              {
                id: 'non-negative',
                name: 'Non-negative',
                state: ({ model }) => {
                  check()
                  return model >= 0
                },
              },
            ]
          : [],
      },
    )
    const lab = makeLab([atlas])
    await analysisScene(
      lab,
      await settle(lab, lab.init()),
      Scene.tap(() => {}),
    )
    if (hasProperties) {
      expect(check).toHaveBeenCalled()
    } else {
      expect(check).not.toHaveBeenCalled()
    }
  },
)

const ReadNumber = Command.define('ReadNumber', {
  messages: [Schema.Number],
  execute: Effect.die('Exploration must not execute Commands'),
})

test('a fixture-free Answer is shown as a Command reply and can be selected', async () => {
  const atlas = make(
    {
      name: 'Deterministic reply',
      Model: Schema.Number,
      Message: Schema.Number,
      start: () => ({ model: 0, commands: [ReadNumber()] }),
      update: (_model, message) => ({ model: message }),
      view: (model, h) => h.p([], [String(model)]),
    },
    {
      *starts() {},
      *next(state) {
        const request = Object.values(pendingRequests(state, ReadNumber))[0]
        return request === undefined
          ? send(yield* fixture<number>('done', {}))
          : answer(request, 1)
      },
    },
  )
  const root = Option.getOrThrow(Array.head(atlas.reach(0).states))
  const reply = Option.getOrThrow(Array.head(atlas.successors(root)))
  const lab = makeLab([atlas])
  await analysisScene(
    lab,
    await settle(lab, lab.init()),
    Scene.tap(simulation => {
      const inspector = Option.getOrThrow(
        Scene.find(simulation.html, 'aside.inspector'),
      )
      expect(Scene.textContent(inspector)).toContain('replies with')
      expect(Scene.textContent(inspector)).not.toContain('User actions')
    }),
    Scene.click(Scene.role('button', { name: `${reply.label} ${reply.to}` })),
    Scene.tap(simulation => {
      expect(
        Scene.textContent(
          Option.getOrThrow(
            Scene.find(simulation.html, '.inspector-head strong'),
          ),
        ),
      ).toBe(reply.to)
      expect(atlas.pending(reply.to)).toEqual([])
    }),
  )
})

test('grouped gallery renders through Foldkit and interactions use selected execution', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
    { properties },
  )
  const lab = makeLab([atlas])
  const model = await dispatch(
    lab,
    await dispatch(lab, await settle(lab, lab.init()), Message.ClickedDeeper()),
    Message.ClickedDeeper(),
  )
  await analysisScene(
    lab,
    model,
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain('groups')
      expect(Scene.textContent(simulation.html)).toContain('incomplete')
      expect(Scene.textContent(simulation.html)).toContain(
        'defined by next(state)',
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
  const chosen = await dispatch(
    lab,
    model,
    Message.ClickedStep({ slot, state: selected }),
  )
  const changed = await dispatch(
    lab,
    chosen,
    Message.InteractedWithCase({
      slot,
      state: selected,
      message: Signup.Message.UpdatedUsername({ value: 'grace' }),
    }),
  )
  const destination = Option.getOrThrow(
    atlas.resolve(changed.positions[slot] ?? []),
  )
  const expected = Option.getOrThrow(
    atlas.interact(
      selected,
      Signup.Message.UpdatedUsername({ value: 'grace' }),
    ),
  )
  expect(destination).toBe(expected)
})

test('filters pinned cards by their displayed state', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
  )
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
  const pinned = await dispatch(
    lab,
    await settle(lab, lab.init()),
    Message.ClickedPin({ state: home }),
  )
  const pricingOnly = await dispatch(
    lab,
    pinned,
    Message.SelectedFilter({ fixture: 'arrivedFrom', option: 'pricing' }),
  )
  await analysisScene(
    lab,
    pricingOnly,
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

test('filters moved cards by their displayed response trace', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
  )
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
    atlas.interact(home, Signup.Message.UpdatedUsername({ value: 'ada' })),
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
  const deep = await dispatch(
    lab,
    await settle(lab, lab.init()),
    Message.ClickedDeeper(),
  )
  const slot = atlas.key(free)
  const moved = await dispatch(
    lab,
    deep,
    Message.ClickedStep({ slot, state: taken }),
  )
  const freeOnly = await dispatch(
    lab,
    moved,
    Message.SelectedFilter({ fixture: 'name', option: 'free' }),
  )
  await analysisScene(
    lab,
    freeOnly,
    Scene.tap(simulation => {
      expect(
        Scene.findAll(simulation.html, 'article.case').some(
          card => card.key === slot,
        ),
      ).toBe(false)
    }),
  )
})

test('keeps a moved card and its stable slot when only its displayed response matches', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
  )
  const lab = makeLab([atlas])
  const initial = await settle(lab, lab.init())
  const home = Option.getOrThrow(initial.maybeSnapshot).states[0]
  if (home === undefined) {
    throw new Error('Missing starting state')
  }
  const slot = home.key
  const checking = await dispatch(
    lab,
    initial,
    Message.InteractedWithCase({
      slot,
      state: home.id,
      message: Signup.Message.UpdatedUsername({ value: 'ada' }),
    }),
  )
  const checkingState = Option.getOrThrow(checking.maybeSnapshot).states.find(
    state => canonical(state.address) === canonical(checking.positions[slot]),
  )
  const free = checkingState?.next.find(
    step => step.kind === 'Answer' && step.label.endsWith(' free'),
  )?.to
  if (free === undefined) {
    throw new Error('Missing modeled free reply')
  }
  const moved = await dispatch(
    lab,
    checking,
    Message.ClickedStep({ slot, state: free }),
  )
  const filtered = await dispatch(
    lab,
    moved,
    Message.SelectedFilter({ fixture: 'name', option: 'free' }),
  )
  const cleared = await dispatch(
    lab,
    filtered,
    Message.ClearedFilter({ fixture: 'name' }),
  )
  for (const model of [filtered, cleared]) {
    await analysisScene(
      lab,
      model,
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
    const selected = Option.getOrThrow(model.maybeSnapshot).states.find(
      state => canonical(state.address) === canonical(model.positions[slot]),
    )
    expect(selected?.id).toBe(free)
  }
})

test('an unmoved group retains its slot when the filter selects a different member', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
  )
  const lab = makeLab([atlas])
  const starts = atlas.reach(0).states
  const home = Option.getOrThrow(Array.head(starts))
  const pricing = Option.getOrThrow(Array.last(starts))
  const filtered = await dispatch(
    lab,
    await settle(lab, lab.init()),
    Message.SelectedFilter({ fixture: 'arrivedFrom', option: 'pricing' }),
  )
  await analysisScene(
    lab,
    filtered,
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

test('previews contain only the app and Inspect selects the slot for replies', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
  )
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
  await analysisScene(
    lab,
    await settle(lab, lab.init()),
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

test('the search control orders the gallery and survives a program switch', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
  )
  const lab = makeLab([atlas])
  const searched = await analysisScene(
    lab,
    await settle(lab, lab.init()),
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
  const model = await dispatch(
    lab,
    await dispatch(lab, searched, Message.SelectedSearch({ search: 'random' })),
    Message.SelectedProgram({ program: 'Signup' }),
  )
  expect(model.search).toBe('random')
  expect((await dispatch(lab, model, Message.ClickedReset())).search).toBe(
    'breadth',
  )
})

test('property evidence names BFS and depth even with a random gallery', async () => {
  const atlas = make(
    {
      name: 'Signup',
      Model: Signup.Model,
      Message: Signup.Message,
      update: Signup.update,
      view: Signup.view,
      start: Signup.init,
    },
    signupEnvironment,
    { properties },
  )
  const lab = makeLab([atlas])
  await analysisScene(
    lab,
    await settle(lab, lab.init()),
    Scene.click(Scene.role('button', { name: 'Random' })),
    Scene.tap(simulation => {
      const inspector = Option.getOrThrow(
        Scene.find(simulation.html, 'aside.inspector'),
      )
      expect(Scene.textContent(inspector)).toContain(
        'no counterexample within limits',
      )
      expect(Scene.textContent(inspector)).toContain(
        'not exercised (unobserved)',
      )
      expect(
        Scene.findAll(simulation.html, '.inspector .is-holding'),
      ).toHaveLength(0)
      expect(Scene.textContent(inspector)).toContain(
        'Breadth-first check through depth 1:',
      )
      expect(Scene.textContent(inspector)).toContain(
        "These are the check's own limits and coverage, not the gallery search.",
      )
    }),
  )
})

test('the inspector renders predicate errors rather than styling them as holding', async () => {
  const atlas = make(
    {
      name: 'Throwing property',
      Model: Schema.Number,
      Message: Schema.Number,
      start: () => ({ model: 0 }),
      update: model => ({ model }),
      view: (_model, h) => h.p([], ['Preview']),
    },
    { *starts() {} },
    {
      properties: [
        {
          id: 'throws',
          name: 'Throws',
          state: () => {
            throw new Error('predicate failed to evaluate')
          },
        },
      ],
    },
  )
  const lab = makeLab([atlas])
  await analysisScene(
    lab,
    await settle(lab, lab.init()),
    Scene.tap(simulation => {
      const inspector = Option.getOrThrow(
        Scene.find(simulation.html, 'aside.inspector'),
      )
      expect(Scene.textContent(inspector)).toContain('Throws: error')
      expect(Scene.textContent(inspector)).toContain(
        'state predicate: predicate failed to evaluate',
      )
      expect(
        Scene.findAll(simulation.html, '.inspector .is-holding'),
      ).toHaveLength(0)
    }),
  )
})
