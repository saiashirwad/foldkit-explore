import { Schema } from 'effect'
import * as Scene from 'foldkit/scene'
import { expect, test } from 'vitest'

import { type Environment, type Program, make, send } from './atlas'
import { compare } from './compare'
import { fixture } from './fixture'
import { Message, makeLab } from './lab'
import * as Review from './review'

const before: Program<number, number> = {
  name: 'Before',
  Model: Schema.Number,
  Message: Schema.Number,
  start: () => ({ model: 0 }),
  update: (_model, message) => ({ model: message }),
  view: (model, h) =>
    h.section(
      [],
      [
        h.h1([], [model === 0 ? 'Start' : 'Confirm account']),
        model === 0 ? h.button([h.OnClick(1)], ['Continue']) : h.empty,
      ],
    ),
}
const after: Program<number, number> = {
  ...before,
  name: 'After',
  view: (model, h) =>
    h.section(
      [],
      [
        h.h1([], [model === 0 ? 'Start' : 'Review account']),
        model === 0 ? h.button([h.OnClick(1)], ['Continue']) : h.empty,
      ],
    ),
}
const environment: Environment<number, number> = {
  *starts() {},
  inputs: [],
  *next(state) {
    return send(yield* fixture('interaction', state.interactions))
  },
}
const lab = () =>
  makeLab(
    [make(before, environment)],
    [
      {
        name: 'Changed heading',
        run: depth =>
          compare({
            before,
            after,
            environment,
            limits: { depth, states: 50, transitions: 100 },
          }),
      },
      {
        name: 'Identical',
        run: depth =>
          compare({
            before,
            after: before,
            environment,
            limits: { depth, states: 50, transitions: 100 },
          }),
      },
      {
        name: 'Shared property failure',
        run: depth =>
          compare({
            before,
            after: before,
            environment,
            properties: [
              { name: 'Stay at start', state: state => state.model === 0 },
            ],
            limits: { depth, states: 50, transitions: 100 },
          }),
      },
    ],
  )

test.each([
  Review.Message.SelectedFinding({ finding: 'F1' }),
  Review.Message.SelectedProperty({ property: 'Positive' }),
])('selecting evidence preserves pagination ($_tag)', message => {
  const review = Review.makeReview([])
  const expanded = review.update(
    Review.initial(),
    Review.Message.ClickedShowMore(),
  ).model
  const viewed = review.update(
    review.update(expanded, Review.Message.SelectedExample({ example: 2 }))
      .model,
    Review.Message.SelectedTraceStep({ step: 3 }),
  ).model
  const selected = review.update(viewed, message).model
  expect(selected.limit).toBe(48)
  expect(selected.example).toBe(0)
  expect(selected.step).toBe(-1)
  expect(selected.replay._tag).toBe('Idle')
})

test.each([
  Review.Message.SelectedComparison({ name: 'Other' }),
  Review.Message.ClickedDeeper(),
  Review.Message.ClickedShallower(),
])('changing the search resets pagination ($_tag)', message => {
  const review = Review.makeReview([])
  const expanded = review.update(
    Review.initial(),
    Review.Message.ClickedShowMore(),
  ).model
  expect(review.update(expanded, message).model.limit).toBe(24)
})

test('Compare mode shows grouped previews and replays the chosen trace through the inspector', () => {
  const application = lab()
  Scene.scene(
    application,
    Scene.given(application.init().model),
    Scene.click(Scene.role('button', { name: 'Compare' })),
    Scene.tap(simulation => {
      expect(
        Scene.findAll(simulation.html, 'article.comparison-card'),
      ).toHaveLength(1)
      expect(Scene.textContent(simulation.html)).toContain('Confirm account')
      expect(Scene.textContent(simulation.html)).toContain('Review account')
      Scene.findAll(simulation.html, '.case-preview').forEach(preview => {
        expect(Scene.textContent(preview)).not.toMatch(
          /Inspect|B\d|A\d|pending|Replay/,
        )
      })
    }),
    Scene.click(Scene.role('button', { name: 'Replay fresh' })),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain(
        'Starting executions',
      )
      expect(Scene.textContent(simulation.html)).toContain(
        'Replayed both versions from fresh starting inputs.',
      )
    }),
    Scene.click(Scene.role('button', { name: 'Next step' })),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain('After step 1')
    }),
    Scene.click(Scene.role('button', { name: 'Explore' })),
    Scene.tap(simulation => {
      expect(
        Scene.findAll(simulation.html, 'article.case').length,
      ).toBeGreaterThan(0)
    }),
  )
})

test('identical versions state the coverage limit without manufacturing a finding', () => {
  const application = lab()
  const compared = application.update(
    application.init().model,
    Message.SelectedMode({ mode: 'Compare' }),
  ).model
  const selected = application.update(
    compared,
    Message.GotReviewMessage({
      message: Review.Message.SelectedComparison({ name: 'Identical' }),
    }),
  ).model
  Scene.scene(
    application,
    Scene.given(selected),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain(
        'No differences found',
      )
      expect(Scene.textContent(simulation.html)).toContain(
        'within these starting inputs, event choices and search limits',
      )
      expect(Scene.findAll(simulation.html, 'article.comparison-card')).toEqual(
        [],
      )
    }),
  )
})

test('shared property failures remain visible and replayable when identical versions have no differences', () => {
  const application = lab()
  const compared = application.update(
    application.init().model,
    Message.SelectedMode({ mode: 'Compare' }),
  ).model
  const selected = application.update(
    compared,
    Message.GotReviewMessage({
      message: Review.Message.SelectedComparison({
        name: 'Shared property failure',
      }),
    }),
  ).model
  Scene.scene(
    application,
    Scene.given(selected),
    Scene.tap(simulation => {
      expect(Scene.findAll(simulation.html, 'article.comparison-card')).toEqual(
        [],
      )
      expect(Scene.textContent(simulation.html)).toContain(
        'No differences found',
      )
      expect(Scene.textContent(simulation.html)).toContain(
        'Observed property failures',
      )
      expect(Scene.textContent(simulation.html)).toContain('Before 1 · After 1')
    }),
    Scene.click(
      Scene.role('button', { name: 'Inspect property Stay at start (state)' }),
    ),
    Scene.click(Scene.role('button', { name: 'Replay fresh' })),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain(
        'Replayed both versions from fresh starting inputs.',
      )
      expect(Scene.textContent(simulation.html)).toContain(
        'Starting executions',
      )
    }),
    Scene.click(Scene.role('button', { name: 'Next step' })),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain('After step 1')
      expect(Scene.textContent(simulation.html)).toContain(
        'Before: Stay at start (state)',
      )
      expect(Scene.textContent(simulation.html)).toContain(
        'After: Stay at start (state)',
      )
      expect(Scene.findAll(simulation.html, 'article.comparison-card')).toEqual(
        [],
      )
    }),
  )
})

test('an exhausted work budget exposes numeric coverage and disables ineffective depth increases', () => {
  const application = makeLab(
    [make(before, environment)],
    [
      {
        name: 'Limited',
        run: depth =>
          compare({
            before,
            after: before,
            environment,
            limits: { depth, states: 50, transitions: 1 },
          }),
      },
    ],
  )
  const compared = application.update(
    application.init().model,
    Message.SelectedMode({ mode: 'Compare' }),
  ).model
  Scene.scene(
    application,
    Scene.given(compared),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain(
        'Search stopped at the transition limit',
      )
      expect(Scene.textContent(simulation.html)).toContain(
        '1 enumerated alternatives',
      )
      expect(Scene.textContent(simulation.html)).toContain(
        '50 states per version',
      )
      expect(
        Scene.getAllByRole('button', {
          name: 'More comparison steps',
          disabled: true,
        })(simulation.html),
      ).toHaveLength(1)
      expect(Scene.findAll(simulation.html, '.comparison-inspector')).toEqual(
        [],
      )
    }),
  )
})

test('raw bigint Models remain inspectable in Compare mode', () => {
  const bigintBefore: Program<bigint, number> = {
    name: 'Before bigint',
    Model: Schema.BigInt,
    Message: Schema.Number,
    start: () => ({ model: 0n }),
    update: model => ({ model }),
    view: (_model, h) => h.p([], ['Before']),
  }
  const bigintAfter: Program<bigint, number> = {
    ...bigintBefore,
    name: 'After bigint',
    view: (_model, h) => h.p([], ['After']),
  }
  const starts: Environment<bigint, number> = { *starts() {} }
  const application = makeLab(
    [make(bigintBefore, starts)],
    [
      {
        name: 'Bigint Model',
        run: depth =>
          compare({
            before: bigintBefore,
            after: bigintAfter,
            environment: starts,
            limits: { depth, states: 10, transitions: 10 },
          }),
      },
    ],
  )
  const compared = application.update(
    application.init().model,
    Message.SelectedMode({ mode: 'Compare' }),
  ).model
  Scene.scene(
    application,
    Scene.given(compared),
    Scene.tap(simulation => {
      expect(Scene.textContent(simulation.html)).toContain('Models')
      expect(Scene.textContent(simulation.html)).toContain('0n')
      expect(
        Scene.findAll(simulation.html, 'article.comparison-card'),
      ).toHaveLength(1)
    }),
  )
})

test('inspecting a later finding preserves cards revealed by Show more', () => {
  const manyBefore: Program<number, number> = {
    ...before,
    view: (model, h) => h.p([], [`Before ${model}`]),
  }
  const manyAfter: Program<number, number> = {
    ...before,
    view: (model, h) => h.p([], [`After ${model}`]),
  }
  const manyEnvironment: Environment<number, number> = {
    *starts() {},
    *next(state) {
      return send(
        yield* fixture(
          'number',
          state.model === 0
            ? Object.fromEntries(
                globalThis.Array.from({ length: 30 }, (_value, index) => [
                  `${index + 1}`,
                  index + 1,
                ]),
              )
            : {},
        ),
      )
    },
  }
  const application = makeLab(
    [make(manyBefore, manyEnvironment)],
    [
      {
        name: 'Many findings',
        run: depth =>
          compare({
            before: manyBefore,
            after: manyAfter,
            environment: manyEnvironment,
            limits: { depth, states: 50, transitions: 100 },
          }),
      },
    ],
  )
  const compared = application.update(
    application.init().model,
    Message.SelectedMode({ mode: 'Compare' }),
  ).model
  Scene.scene(
    application,
    Scene.given(compared),
    Scene.click(Scene.role('button', { name: 'Show more findings' })),
    Scene.click(Scene.nth(25)(Scene.all.role('button', { name: 'Inspect' }))),
    Scene.tap(simulation => {
      expect(
        Scene.findAll(simulation.html, 'article.comparison-card'),
      ).toHaveLength(31)
      expect(
        Scene.findAll(simulation.html, 'article.comparison-card.is-selected'),
      ).toHaveLength(1)
    }),
  )
})
