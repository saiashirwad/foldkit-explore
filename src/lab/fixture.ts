import { Array, Option, Record, Schema } from 'effect'

// FIXTURE

export type Fixture = Readonly<{
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
    Array.findFirst(Record.values(cases), value => value === chosen),
    () => new Error(`Fixture "${name}" received a value it does not offer.`),
  )
}

// OUTCOMES

export type Outcome<Output> = Readonly<{
  decisions: ReadonlyArray<Decision>
  value: Output
}>

const replay = <Output>(
  choices: () => Choices<Output>,
  decisions: ReadonlyArray<Decision>,
) => {
  const generator = choices()
  return Array.reduce(decisions, generator.next(), (step, decision) => {
    if (
      step.done ||
      step.value.name !== decision.fixture ||
      !Object.hasOwn(step.value.cases, decision.option)
    ) {
      throw new Error('Fixture replay diverged; choices must be deterministic.')
    }
    return generator.next(step.value.cases[decision.option])
  })
}

export const outcomes = <Output>(
  choices: () => Choices<Output>,
  decisions: ReadonlyArray<Decision> = [],
): ReadonlyArray<Outcome<Output>> => {
  const step = replay(choices, decisions)
  if (step.done) {
    return [{ decisions, value: step.value }]
  }
  const { name, cases } = step.value
  if (Array.some(decisions, decision => decision.fixture === name)) {
    throw new Error(`Fixture "${name}" appears twice along one path.`)
  }
  return Array.flatMap(Record.keys(cases), option =>
    outcomes(choices, Array.append(decisions, { fixture: name, option })),
  )
}
