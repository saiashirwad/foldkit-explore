# Foldkit Explore

Every state a Foldkit program can reach, on one page.

You describe what can vary as named choices: the starting Model, what a user might do, and how each Command might be answered. The lab then walks the program's real `update` through every combination and renders each distinct state with the program's real `view`.

```ts
export function* WeatherCases(): Choices<Setup<Model, Message>> {
  const zipCodeInput = yield* fixture('zip', { empty: '', valid: '90210' })
  return {
    model: { zipCodeInput, weather: WeatherAsyncData.Idle() },
    moves,
    responders: [
      respond(FetchWeather, function* ({ zipCode }) {
        if (zipCode === '') {
          return Message.FailedFetchWeather({ error: 'Zip code required' })
        }
        return yield* fixture('result', {
          succeeded: Message.SucceededFetchWeather({ weather }),
          failed: Message.FailedFetchWeather({ error: 'Location not found' }),
        })
      }),
    ],
  }
}
```

A choice only exists on paths where control flow reaches it. Above, `result` appears only once a non-empty zip code is being fetched.

## Run it

```bash
bun install
bun dev            # then open /lab.html
bun run test       # snapshots every reachable state into src/lab/*.atlas
```

In the lab you can:

- filter by any choice;
- go deeper one step at a time;
- click inside a card to drive it like the real app;
- answer a pending Command from the card;
- rewind through a state's trace in the inspector;
- pin a state to keep it.

## How it stays fast

- **States are values.** `update` is pure and Models are plain data, so exploring never replays history. Each state is stepped from directly.
- **Equal states merge.** Models are hash-consed (`src/lab/identity.ts`), so two paths to the same state become one card. Identifying a new state only visits the objects `update` replaced.
- **Work is memoized.** Each state's successors are computed once. Each card's view re-renders only when its state changes (`createKeyedLazy`).
- **Addresses outlive sessions.** The lab's Model refers to states by the path of choices that reaches them, so a reload finds the same states again.

## Layout

| Path | What |
| --- | --- |
| `src/lab/fixture.ts` | `fixture()` and `outcomes()`: named choices, enumerated by replay |
| `src/lab/identity.ts` | Hash-consing for structural sharing between states |
| `src/lab/atlas.ts` | A program's memoized state graph: setups, moves, answers, addresses |
| `src/lab/lab.ts` | The lab itself, a Foldkit program |
| `src/main.cases.ts`, `src/release/main.cases.ts` | Cases for the two example programs |
