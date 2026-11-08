# Foldkit Explore

Show the states a Foldkit program can reach, so you can look at them.

You describe the world: how the program starts, and what can happen next. The explorer runs your real `update` from every start, follows every move, merges states it has seen, and renders each one in a gallery. Commands never run. You answer them, in any order.

```sh
bun dev   # open /lab.html
```

## The generator form

A `fixture` is a named choice. Every combination of choices is explored; control flow decides which fixtures are reached, and a fixture with no cases prunes its path.

```ts
function* starts(): Choices<string> {
  return yield* fixture('zip', { empty: '', valid: '90210' })
}

function* next(state: State<Model, Message, string>): Choices<Move<Message>> {
  const kind = yield* fixture('next', { user: 'user', reply: 'reply' })
  if (kind === 'user') {
    return send(yield* fixture('move', { typed: Message.Typed({ value: '9' }) }))
  }
  const request = yield* fixture('pending', pendingRequests(state, FetchWeather))
  return answer(request, yield* fixture('result', { ok: Message.Loaded(), failed: Message.Failed() }))
}
```

- `send(message)`: something happened. Pending Commands stay pending.
- `answer(request, message)`: reply to one pending Command.

## API

```ts
const graph = explore(program, environment, { depth: 3, states: 200 })
// { nodes, edges, isComplete }
```

| | |
| --- | --- |
| `Program` | `name`, `start(input)`, `update`, `view` |
| `Environment.starts` | choices that produce starting inputs |
| `Environment.next` | choices that produce the next `Move` from a `State` |
| `Environment.prune` | drop a state: not stored, not explored through |
| `Environment.show` | explore a state but leave it out of the gallery |
| `Environment.key` | states with equal keys merge; return less to merge more |

`isComplete` is only true when neither `depth` nor `states` cut the search short. It means complete for this environment, not for every possible browser or server.

The gallery has the same controls: step depth, and prune a state with its button to drop it and everything reachable only through it.

## Comparing versions

```ts
const { findings, isComplete } = compare(before, after, environment, { depth: 3, states: 200 })
```

Both versions run in the same environment. States are paired by the choices that led to them. Each finding is a different screen, different pending Commands, or a move only one version offers. Findings are grouped, with a count and the shortest path. If `isComplete` is false, no findings is not equivalence.

## Layout

| Path | Role |
| --- | --- |
| `src/explore/choices.ts` | `fixture`, `outcomes` |
| `src/explore/explore.ts` | `Program`, `Environment`, `explore` |
| `src/explore/compare.ts`, `screen.ts` | compare two versions in one environment |
| `src/explore/key.ts` | stable key for plain data |
| `src/explore/lab.ts` | the gallery |
| `src/main.ts`, `src/release/`, `src/signup/` | example programs and their `main.cases.ts` environments |
