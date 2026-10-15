import { Array, Option, Record, Schema } from 'effect'

import { ReplayDivergenceError } from './replay'

// FIXTURE

type Fixture = Readonly<{
  name: string
  cases: Readonly<Record<string, unknown>>
}>

export const Decision = Schema.Struct({
  fixture: Schema.String,
  option: Schema.String,
})
export type Decision = typeof Decision.Type

export type Choices<Output> = Generator<Fixture, Output, unknown>

export function* fixture<const Value>(
  name: string,
  cases: Readonly<Record<string, Value>>,
): Choices<Value> {
  const chosen = yield { name, cases }
  return Option.getOrThrowWith(
    Array.findFirst(Record.values(cases), value => Object.is(value, chosen)),
    () => new Error(`Fixture "${name}" received a value it does not offer.`),
  )
}

// OUTCOMES

export type Outcome<Output> = Readonly<{
  decisions: ReadonlyArray<Decision>
  value: Output
}>

// NOTE: Selected-decision replay never visits sibling paths and closes the
// authored generator when the caller cancels between advancement checkpoints.
export function* replaySteps<Output>(
  choices: () => Choices<Output>,
  decisions: ReadonlyArray<Decision>,
): Generator<void, Output> {
  const generator: Iterator<Fixture, Output, unknown> = choices()
  try {
    yield
    const cursor = { step: generator.next(), index: 0 }
    while (!cursor.step.done && cursor.index < decisions.length) {
      const decision = decisions[cursor.index]
      if (
        decision === undefined ||
        cursor.step.value.name !== decision.fixture
      ) {
        throw new ReplayDivergenceError(
          'fixture',
          'Fixture replay diverged: the recorded fixture is no longer available.',
        )
      }
      if (!Object.hasOwn(cursor.step.value.cases, decision.option)) {
        throw new ReplayDivergenceError(
          'option',
          `Fixture replay diverged: option ${JSON.stringify(decision.option)} is no longer available.`,
        )
      }
      yield
      cursor.step = generator.next(cursor.step.value.cases[decision.option])
      cursor.index += 1
    }
    if (!cursor.step.done) {
      throw new ReplayDivergenceError(
        'incomplete-decisions',
        'Fixture replay ended before its environment choices were complete.',
      )
    }
    if (cursor.index !== decisions.length) {
      throw new ReplayDivergenceError(
        'excessive-decisions',
        'Fixture replay has decisions after its environment completed.',
      )
    }
    return cursor.step.value
  } finally {
    generator.return?.()
  }
}

export type EnumerationStep<Output> =
  | Readonly<{ kind: 'work' }>
  | Readonly<{ kind: 'outcome'; outcome: Outcome<Output> }>

type Branch = {
  readonly path: ReadonlyArray<Decision>
  readonly name: string
  readonly options: Iterator<string>
}

// NOTE: Each next() performs at most one generator advancement or sibling
// selection. Enumerators own suspended generators; return() releases them.
export function* enumerate<Output>(
  choices: () => Choices<Output>,
): Generator<EnumerationStep<Output>, void, unknown> {
  const branches: Array<Branch> = []
  const cursor: { path: ReadonlyArray<Decision> | undefined } = { path: [] }
  while (cursor.path !== undefined || Array.isArrayNonEmpty(branches)) {
    if (cursor.path === undefined) {
      const branch = branches.at(-1)
      const option = branch?.options.next()
      if (branch !== undefined && option !== undefined && !option.done) {
        cursor.path = Array.append(branch.path, {
          fixture: branch.name,
          option: option.value,
        })
      } else {
        branches.pop()
      }
      yield { kind: 'work' }
    } else {
      const path = cursor.path
      const generator: Iterator<Fixture, Output, unknown> = choices()
      try {
        const replayed = { index: 0, step: generator.next() }
        while (!replayed.step.done && replayed.index < path.length) {
          yield { kind: 'work' }
          const decision = path[replayed.index]
          if (
            decision === undefined ||
            replayed.step.value.name !== decision.fixture ||
            !Object.hasOwn(replayed.step.value.cases, decision.option)
          ) {
            throw new Error(
              'Fixture replay diverged; choices must be deterministic.',
            )
          }
          replayed.step = generator.next(
            replayed.step.value.cases[decision.option],
          )
          replayed.index += 1
        }
        if (replayed.index !== path.length) {
          throw new Error(
            'Fixture replay diverged; choices must be deterministic.',
          )
        }
        if (replayed.step.done) {
          yield {
            kind: 'outcome',
            outcome: { decisions: path, value: replayed.step.value },
          }
        } else {
          const { name, cases } = replayed.step.value
          if (Array.some(path, decision => decision.fixture === name)) {
            throw new Error(`Fixture "${name}" appears twice along one path.`)
          }
          branches.push({
            path,
            name,
            options: Record.keys(cases)[Symbol.iterator](),
          })
          yield { kind: 'work' }
        }
      } finally {
        generator.return?.()
      }
      cursor.path = undefined
    }
  }
}

// NOTE: This convenience iterator is unbounded. Search engines consume
// enumerate() directly so pruned paths and replay work remain interruptible.
export function* outcomes<Output>(
  choices: () => Choices<Output>,
): Generator<Outcome<Output>, void, unknown> {
  for (const step of enumerate(choices)) {
    if (step.kind === 'outcome') {
      yield step.outcome
    }
  }
}
