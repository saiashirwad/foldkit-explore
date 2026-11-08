import { Array, Option, Record } from 'effect'

// CHOICES

type Fixture = Readonly<{
  name: string
  cases: Readonly<Record<string, unknown>>
}>

export type Choices<Output> = Generator<Fixture, Output, unknown>

// NOTE: A fixture with no cases has no outcomes, so it prunes its path.
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
  // The option picked at each fixture, in order.
  path: ReadonlyArray<string>
  value: Output
}>

type Step<Output> =
  | Readonly<{ done: true; value: Output }>
  | Readonly<{ done: false; cases: ReadonlyArray<string> }>

// NOTE: Generators cannot be cloned, so each path is replayed from the start.
// Choices must be deterministic.
const replay = <Output>(
  choices: () => Choices<Output>,
  path: ReadonlyArray<string>,
): Step<Output> => {
  const generator = choices()
  let step = generator.next()
  for (const option of path) {
    if (step.done || !Object.hasOwn(step.value.cases, option)) {
      throw new Error('Choices replayed differently; they must be pure.')
    }
    step = generator.next(step.value.cases[option])
  }
  return step.done
    ? { done: true, value: step.value }
    : { done: false, cases: Object.keys(step.value.cases) }
}

// Every path through the fixtures, depth first.
export function* outcomes<Output>(
  choices: () => Choices<Output>,
  path: ReadonlyArray<string> = [],
): Generator<Outcome<Output>> {
  const step = replay(choices, path)
  if (step.done) {
    yield { path, value: step.value }
    return
  }
  for (const option of step.cases) {
    yield* outcomes(choices, Array.append(path, option))
  }
}
