import { Array, Effect, Exit, Layer, Option, Schema, Scope } from 'effect'
import * as Scene from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { expect, test, vi } from 'vitest'

import { AnalysisStatus } from './analysis-data'
import { dispatch, settle } from './analysis-test'
import { type Environment, type Program, make, send } from './atlas'
import { createComparison } from './compare'
import { fixture } from './fixture'
import { Message, type Model, makeLab } from './lab'
import * as Review from './review'

const instrumented = (name = 'Counter') => {
  const calls = { start: 0, update: 0, next: 0 }
  const program: Program<number, number> = {
    name,
    Model: Schema.Number,
    Message: Schema.Number,
    start: () => {
      calls.start += 1
      return { model: 0 }
    },
    update: (_model, message) => {
      calls.update += 1
      return { model: message }
    },
    view: (model, h) => h.button([h.OnClick(model + 1)], [`Count ${model}`]),
  }
  const environment: Environment<number, number> = {
    *starts() {},
    *next(state) {
      calls.next += 1
      return send(
        yield* fixture(
          'increment',
          state.model < 3 ? { next: state.model + 1 } : {},
        ),
      )
    },
  }
  return { calls, program, environment, atlas: make(program, environment) }
}

const firstCommand = (result: ReturnType<ReturnType<typeof makeLab>['init']>) =>
  Option.getOrThrow(Array.head(result.commands ?? []))

const render = (application: ReturnType<typeof makeLab>, model: Model) => {
  Scene.scene(
    application,
    Scene.given(model),
    Scene.tap(() => {}),
  )
}

test('gallery init, update and fixed-Model views never execute analysis', async () => {
  const example = instrumented()
  const application = makeLab([example.atlas])
  const initial = application.init()
  render(application, initial.model)
  render(application, initial.model)
  application.update(initial.model, Message.ClickedDeeper())
  application.update(initial.model, Message.ClickedReset())
  expect(example.calls).toEqual({ start: 0, update: 0, next: 0 })

  const completed = await settle(application, initial)
  const previous = { ...example.calls }
  expect(completed.analysis._tag).toBe('Completed')
  expect(Schema.is(application.Model)(completed)).toBe(true)
  expect(Object.isFrozen(Option.getOrThrow(completed.maybeSnapshot))).toBe(true)
  render(application, completed)
  render(application, completed)
  expect(example.calls).toEqual(previous)

  const state = Option.getOrThrow(completed.maybeSnapshot).states[0]
  if (state === undefined) {
    throw new Error('Missing root')
  }
  const clicked = application.update(
    completed,
    Message.InteractedWithCase({
      slot: state.key,
      state: state.id,
      message: 2,
    }),
  )
  expect(example.calls).toEqual(previous)
  expect(clicked.model.positions).toEqual(completed.positions)
  const interacted = await settle(application, clicked)
  expect(example.calls.update).toBeGreaterThan(previous.update)
  expect(interacted.positions[state.key]).toBeDefined()
  await Effect.runPromise(application.dispose)
})

test('comparison construction, fixed-Model views and replay update are pure', async () => {
  const example = instrumented()
  const candidate = {
    ...example.program,
    name: 'Candidate',
    view: (model: number, h: Parameters<typeof example.program.view>[1]) =>
      h.p([], [`Candidate ${model}`]),
  }
  const scenario = Review.makeComparisonCase('Difference', {
    before: example.program,
    after: candidate,
    environment: example.environment,
    limits: { depth: 2, states: 20, transitions: 100 },
  })
  const create = vi.fn(scenario.create)
  const application = makeLab([example.atlas], [{ ...scenario, create }])
  const initial = application.init().model
  const compared = application.update(
    initial,
    Message.SelectedMode({ mode: 'Compare' }),
  )
  render(application, compared.model)
  render(application, compared.model)
  expect(create).not.toHaveBeenCalled()
  expect(example.calls).toEqual({ start: 0, update: 0, next: 0 })

  const completed = await settle(application, compared)
  const previous = { ...example.calls }
  expect(completed.review.analysis._tag).toBe('Completed')
  expect(Schema.is(application.Model)(completed)).toBe(true)
  render(application, completed)
  render(application, completed)
  const replay = application.update(
    completed,
    Message.GotReviewMessage({ message: Review.Message.ClickedReplay() }),
  )
  expect(replay.model.review.replay._tag).toBe('Running')
  expect(example.calls).toEqual(previous)
  const verified = await settle(application, replay)
  expect(verified.review.replay._tag).toBe('Verified')
  expect(example.calls.start).toBeGreaterThan(previous.start)
  await Effect.runPromise(application.dispose)
})

test('comparison creates no starts until bounded advancement', () => {
  const example = instrumented()
  const comparison = createComparison({
    before: example.program,
    after: example.program,
    environment: example.environment,
    limits: { depth: 1, states: 20, transitions: 100 },
  })
  expect(example.calls.start).toBe(0)
  expect(comparison.status).toBe('running')
  expect(comparison.advance(1)).toBe(false)
  expect(comparison.status).toBe('running')
  expect(comparison.counters.enumerationWork).toBe(1)
  comparison.dispose()
  expect(() => comparison.advance(1)).toThrow('disposed')
})

test('gallery rejects stale progress, live completions and reset results', async () => {
  const example = instrumented()
  const application = makeLab([example.atlas])
  const initial = application.init()
  const completion = await Effect.runPromise(firstCommand(initial).effect)
  const cancelled = application.update(initial.model, Message.ClickedCancel())
  expect(cancelled.model.analysis._tag).toBe('Cancelled')
  expect(application.update(cancelled.model, completion)).toEqual({
    model: cancelled.model,
  })
  const reset = application.update(cancelled.model, Message.ClickedReset())
  expect(reset.model.runId).toBeGreaterThan(cancelled.model.runId)
  expect(application.update(reset.model, completion)).toEqual({
    model: reset.model,
  })
  await settle(application, cancelled)
  const completed = await settle(application, reset)
  const root = Option.getOrThrow(completed.maybeSnapshot).states[0]
  if (root === undefined) {
    throw new Error('Missing root')
  }
  const interaction = application.update(
    completed,
    Message.InteractedWithCase({ slot: root.key, state: root.id, message: 2 }),
  )
  const result = await Effect.runPromise(firstCommand(interaction).effect)
  const switched = application.update(
    interaction.model,
    Message.SelectedProgram({ program: example.program.name }),
  )
  expect(application.update(switched.model, result)).toEqual({
    model: switched.model,
  })
  await settle(application, switched)
  await Effect.runPromise(application.dispose)
})

test('comparison rejects stale progress and replay completion after cancellation and switches', async () => {
  const example = instrumented()
  const application = makeLab(
    [example.atlas],
    [
      Review.makeComparisonCase('Same', {
        before: example.program,
        after: example.program,
        environment: example.environment,
        limits: { depth: 1, states: 20, transitions: 100 },
      }),
    ],
  )
  const started = application.update(
    application.init().model,
    Message.SelectedMode({ mode: 'Compare' }),
  )
  const cancelled = application.update(
    started.model,
    Message.GotReviewMessage({ message: Review.Message.ClickedCancel() }),
  )
  const stale = Message.GotReviewMessage({
    message: Review.Message.CompletedAnalyzeComparison({
      runId: started.model.review.runId,
      status: AnalysisStatus.Completed(),
      maybeSnapshot: Option.none(),
    }),
  })
  expect(application.update(cancelled.model, stale).model.review).toBe(
    cancelled.model.review,
  )
  const replayed = Message.GotReviewMessage({
    message: Review.Message.CompletedReplayComparison({
      runId: started.model.review.runId,
      status: AnalysisStatus.Completed(),
    }),
  })
  expect(
    application.update(cancelled.model, replayed).model.review.replay._tag,
  ).not.toBe('Verified')
  const switched = application.update(
    started.model,
    Message.SelectedProgram({ program: example.program.name }),
  )
  expect(switched.model.review.runId).toBeGreaterThan(
    started.model.review.runId,
  )
  expect(application.update(switched.model, stale).model.review).toBe(
    switched.model.review,
  )
  await settle(application, switched)
  await Effect.runPromise(application.dispose)
})

const pruned = () => {
  const work = { opened: 0, closed: 0, visits: 0 }
  const program: Program<number, number> = {
    name: 'Pruned',
    Model: Schema.Number,
    Message: Schema.Number,
    start: () => ({ model: 0 }),
    update: model => ({ model }),
    view: (_model, h) => h.p([], ['Pruned']),
  }
  const environment: Environment<number, number> = {
    *starts() {
      work.opened += 1
      try {
        for (const index of Array.range(1, 16)) {
          work.visits += 1
          yield* fixture(`axis${index}`, { a: 0, b: 1 })
        }
        return yield* fixture('pruned', {})
      } finally {
        work.closed += 1
      }
    },
  }
  return { work, program, environment }
}

test.each(['gallery', 'comparison'])(
  '%s yields and cancels inside a fully pruned tree',
  async kind => {
    const example = pruned()
    const atlas = make(example.program, example.environment)
    const cases =
      kind === 'comparison'
        ? [
            Review.makeComparisonCase('Pruned comparison', {
              before: example.program,
              after: example.program,
              environment: example.environment,
              limits: {
                depth: 1,
                states: 20,
                transitions: 100,
                enumerationWork: 100_000,
              },
            }),
          ]
        : []
    const application = makeLab([atlas], cases)
    const initial =
      kind === 'comparison'
        ? application.update(
            application.init().model,
            Message.SelectedMode({ mode: 'Compare' }),
          )
        : application.init()
    const command = initial.commands?.find(
      command =>
        command.name ===
        (kind === 'comparison' ? 'AnalyzeComparison' : 'AnalyzeGallery'),
    )
    if (command === undefined) {
      throw new Error('Missing analysis Command')
    }
    const pending = Effect.runPromise(command.effect)
    expect(example.work.visits).toBe(0)
    await Promise.resolve()
    expect(example.work.visits).toBe(0)
    const progress = await pending
    expect(example.work.visits).toBeGreaterThan(0)
    expect(example.work.visits).toBeLessThanOrEqual(128)
    const advanced = application.update(initial.model, progress)
    const status =
      kind === 'comparison'
        ? advanced.model.review.analysis
        : advanced.model.analysis
    expect(status._tag).toBe('Running')
    const nextCommand = advanced.commands?.[0]
    if (nextCommand === undefined) {
      throw new Error('Missing continuation')
    }
    const cancelled = application.update(
      advanced.model,
      kind === 'comparison'
        ? Message.GotReviewMessage({ message: Review.Message.ClickedCancel() })
        : Message.ClickedCancel(),
    )
    await settle(application, cancelled)
    expect(example.work.closed).toBe(example.work.opened)
    const stopped = { ...example.work }
    const stale = await Effect.runPromise(nextCommand.effect)
    expect(example.work).toEqual(stopped)
    expect(application.update(cancelled.model, stale).model).toEqual(
      cancelled.model,
    )
    await Effect.runPromise(application.dispose)
  },
)

test('increasing comparison depth reuses one session; smaller bounds and reset release it', async () => {
  const example = instrumented()
  const scenario = Review.makeComparisonCase('Same', {
    before: example.program,
    after: example.program,
    environment: example.environment,
    limits: { depth: 1, states: 20, transitions: 100 },
  })
  const disposed = vi.fn()
  const create = vi.fn((depth: number) => {
    const session = scenario.create(depth)
    const dispose = session.dispose
    vi.spyOn(session, 'dispose').mockImplementation(() => {
      disposed()
      dispose()
    })
    return session
  })
  const application = makeLab([example.atlas], [{ ...scenario, create }])
  const initial = modifyFields(application.init().model, {
    review: model => modifyFields(model, { depth: () => 1 }),
  })
  const completed = await settle(
    application,
    application.update(initial, Message.SelectedMode({ mode: 'Compare' })),
  )
  const starts = example.calls.start
  const original = Option.getOrThrow(completed.review.maybeSnapshot)
  const captured = original.findings.length
  const deeper = await dispatch(
    application,
    completed,
    Message.GotReviewMessage({ message: Review.Message.ClickedDeeper() }),
  )
  expect(create).toHaveBeenCalledTimes(1)
  expect(example.calls.start).toBe(starts)
  expect(
    Option.getOrThrow(deeper.review.maybeSnapshot).counters.beforeStates,
  ).toBeGreaterThan(original.counters.beforeStates)
  expect(Object.isFrozen(original)).toBe(true)
  expect(original.findings).toHaveLength(captured)
  const smaller = await dispatch(
    application,
    deeper,
    Message.GotReviewMessage({ message: Review.Message.ClickedShallower() }),
  )
  expect(create).toHaveBeenCalledTimes(2)
  expect(disposed).toHaveBeenCalledTimes(1)
  const reset = await dispatch(
    application,
    smaller,
    Message.GotReviewMessage({ message: Review.Message.ClickedReset() }),
  )
  expect(create).toHaveBeenCalledTimes(3)
  expect(disposed).toHaveBeenCalledTimes(2)
  await dispatch(application, reset, Message.SelectedMode({ mode: 'Explore' }))
  expect(disposed).toHaveBeenCalledTimes(3)
  await Effect.runPromise(application.dispose)
})

test('runtime resource scope shutdown closes unfinished sessions', async () => {
  const example = pruned()
  const application = makeLab([make(example.program, example.environment)])
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(Layer.buildWithScope(application.resources, scope))
  const initial = application.init()
  await Effect.runPromise(firstCommand(initial).effect)
  expect(example.work.opened).toBeGreaterThan(0)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  expect(example.work.closed).toBe(example.work.opened)
  const stopped = { ...example.work }
  const stale = await Effect.runPromise(firstCommand(initial).effect)
  expect(stale._tag === 'CompletedAnalyzeGallery' && stale.status._tag).toBe(
    'Cancelled',
  )
  expect(example.work).toEqual(stopped)
})

test.each(['invalid', 'exception'])(
  'runner distinguishes %s Model failure from successful completion',
  async kind => {
    const example = instrumented()
    const program = {
      ...example.program,
      start: () => {
        if (kind === 'exception') {
          throw new Error('Application crashed')
        }
        return { model: Number.NaN }
      },
      Model: Schema.Int,
    }
    const application = makeLab([make(program, example.environment)])
    const result = await settle(application, application.init())
    expect(result.analysis._tag).toBe(
      kind === 'invalid' ? 'InvalidModel' : 'Defect',
    )
    expect(Option.isNone(result.maybeSnapshot)).toBe(true)
    render(application, result)
    await Effect.runPromise(application.dispose)
  },
)

test('gallery positions replay behind Commands after its session is released', async () => {
  const example = instrumented()
  const scenario = Review.makeComparisonCase('Same', {
    before: example.program,
    after: example.program,
    environment: example.environment,
    limits: { depth: 1, states: 20, transitions: 100 },
  })
  const application = makeLab([example.atlas], [scenario])
  const initial = await settle(application, application.init())
  const root = Option.getOrThrow(initial.maybeSnapshot).states[0]
  if (root === undefined) {
    throw new Error('Missing root')
  }
  const moved = await dispatch(
    application,
    initial,
    Message.InteractedWithCase({ slot: root.key, state: root.id, message: 2 }),
  )
  const address = moved.positions[root.key]
  const compared = await dispatch(
    application,
    moved,
    Message.SelectedMode({ mode: 'Compare' }),
  )
  const restored = await dispatch(
    application,
    compared,
    Message.SelectedMode({ mode: 'Explore' }),
  )
  expect(restored.positions[root.key]).toEqual(address)
  Scene.scene(
    application,
    Scene.given(restored),
    Scene.tap(simulation => {
      const card = Scene.findAll(simulation.html, 'article.case').find(
        card => card.key === root.key,
      )
      expect(card).toBeDefined()
      if (card !== undefined) {
        expect(Scene.textContent(card)).toContain('Count 2')
      }
    }),
  )
  await Effect.runPromise(application.dispose)
})

test('cleanup defects are reported rather than turning cancellation into success', async () => {
  const example = pruned()
  const state = { failCleanup: false }
  const environment: Environment<number, number> = {
    *starts() {
      try {
        return yield* example.environment.starts()
      } finally {
        if (state.failCleanup) {
          throw new Error('Cleanup defect')
        }
      }
    },
  }
  const application = makeLab([make(example.program, environment)])
  const initial = application.init()
  const progress = await Effect.runPromise(firstCommand(initial).effect)
  const running = application.update(initial.model, progress).model
  state.failCleanup = true
  const cancelled = await settle(
    application,
    application.update(running, Message.ClickedCancel()),
  )
  expect(cancelled.analysis._tag).toBe('Defect')
  expect(example.work.closed).toBe(example.work.opened)
  await Effect.runPromise(application.dispose)
})

test('fresh gallery sessions preserve moved slots when a group member has different start context', async () => {
  const example = instrumented()
  const program: Program<number, number, string> = {
    ...example.program,
    start: () => ({ model: 0 }),
  }
  const environment: Environment<number, number, string> = {
    *starts() {
      return yield* fixture('plan', { free: 'Free', pro: 'Pro' })
    },
  }
  const application = makeLab(
    [make(program, environment)],
    [
      Review.makeComparisonCase('Same', {
        before: program,
        after: program,
        environment,
        limits: { depth: 1, states: 20, transitions: 100 },
      }),
    ],
  )
  const initial = await settle(application, application.init())
  const snapshot = Option.getOrThrow(initial.maybeSnapshot)
  const home = snapshot.states[0]
  const other = snapshot.states[1]
  if (home === undefined || other === undefined) {
    throw new Error('Missing distinct roots')
  }
  const selected = await dispatch(
    application,
    initial,
    Message.ClickedStep({ slot: home.key, state: other.id }),
  )
  const moved = await dispatch(
    application,
    selected,
    Message.InteractedWithCase({ slot: home.key, state: other.id, message: 2 }),
  )
  const compared = await dispatch(
    application,
    moved,
    Message.SelectedMode({ mode: 'Compare' }),
  )
  const restored = await dispatch(
    application,
    compared,
    Message.SelectedMode({ mode: 'Explore' }),
  )
  Scene.scene(
    application,
    Scene.given(restored),
    Scene.tap(simulation => {
      const card = Scene.findAll(simulation.html, 'article.case').find(
        card => card.key === home.key,
      )
      expect(card).toBeDefined()
      if (card !== undefined) {
        expect(Scene.textContent(card)).toContain('Count 2')
      }
    }),
  )
  await Effect.runPromise(application.dispose)
})

test.each(['cancel', 'dispose'])(
  'restarting a multi-chunk replay closes its previous generator before %s',
  async boundary => {
    const lifetime = { opened: 0, closed: 0 }
    const example = instrumented()
    const after: Program<number, number> = {
      ...example.program,
      name: 'Changed',
      view: (model, h) => h.p([], [`Changed ${model}`]),
    }
    const environment: Environment<number, number> = {
      *starts() {
        lifetime.opened += 1
        try {
          for (const axis of Array.range(1, 300)) {
            yield* fixture(`axis${axis}`, { only: 0 })
          }
        } finally {
          lifetime.closed += 1
        }
      },
    }
    const application = makeLab(
      [make(example.program, environment)],
      [
        Review.makeComparisonCase('Long replay', {
          before: example.program,
          after,
          environment,
          limits: {
            depth: 0,
            states: 10,
            transitions: 10,
            enumerationWork: 100_000,
          },
        }),
      ],
    )
    const completed = await settle(
      application,
      application.update(
        application.init().model,
        Message.SelectedMode({ mode: 'Compare' }),
      ),
    )
    expect(completed.review.analysis._tag).toBe('Completed')
    expect(lifetime.opened).toBe(lifetime.closed)

    const first = application.update(
      completed,
      Message.GotReviewMessage({ message: Review.Message.ClickedReplay() }),
    )
    const firstProgress = await Effect.runPromise(firstCommand(first).effect)
    const running = application.update(first.model, firstProgress).model
    expect(running.review.replay._tag).toBe('Running')
    expect(lifetime.opened - lifetime.closed).toBe(1)
    const previousClosed = lifetime.closed

    const replacement = application.update(
      running,
      Message.GotReviewMessage({ message: Review.Message.ClickedReplay() }),
    )
    const replacementProgress = await Effect.runPromise(
      firstCommand(replacement).effect,
    )
    const replaced = application.update(
      replacement.model,
      replacementProgress,
    ).model
    expect(replaced.review.replay._tag).toBe('Running')
    expect(lifetime.closed).toBe(previousClosed + 1)
    expect(lifetime.opened - lifetime.closed).toBe(1)
    expect(application.update(replaced, firstProgress).model.review).toBe(
      replaced.review,
    )

    if (boundary === 'cancel') {
      await settle(
        application,
        application.update(
          replaced,
          Message.GotReviewMessage({ message: Review.Message.ClickedCancel() }),
        ),
      )
    } else {
      await Effect.runPromise(application.dispose)
    }
    expect(lifetime.closed).toBe(lifetime.opened)
    await Effect.runPromise(application.dispose)
  },
)
