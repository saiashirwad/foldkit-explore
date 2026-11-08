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

## Checks

```ts
violations(graph, state => state.model.status !== 'loading' || state.pending.length > 0)
deadEnds(graph, limits.depth)
```

`violations` returns the explored states where your rule fails, each with its shortest path. `deadEnds` returns states with no move to a different state; the gallery marks them. Some are fine, such as a finished signup. Both only cover what was explored.

## Finding a state, and what was never exercised

```ts
find(program, environment, state => state.model.step._tag === 'Failed', { depth: 12, states: 3_000 })
// { found: { path, model } | undefined, isComplete }
neverSent(graph, tagsOf(Message))
```

`find` stops at the first state your rule accepts and returns the shortest path to it, so it can go much deeper than a full search. `isComplete` tells you whether a miss covers everything reachable. `neverSent` lists declared Messages that no explored move sent: either unreachable in this environment, or never offered by it. The gallery has both: a search box, and a "Messages never sent" note.

To merge look-alike states while exploring, use `key: byScreen(program.view)`. The gallery has a toggle for it.

## Turning a state into a test

```ts
storyOf(graph, id)
```

Returns a Foldkit `story` test that starts where the explorer started, makes each move on the way to that state (a Command answer becomes `Command.resolve`), and checks the Model it ends in. A story fails while Commands are pending, so any still pending at that state are listed with a TODO. Adjust the import path and run your formatter. The gallery shows it under "Test for this state" in the sidebar.

## Baselines for CI

```ts
expectBaseline('src/signup/signup.states.json', snapshotOf(program, environment, limits))
```

`snapshotOf` records every explored state: what it shows (its text, and a hash of everything rendered), its pending Commands, and where each move leads. Commit the file. `expectBaseline` (in a vitest test) fails with the differences when the code no longer matches it, and no old code is needed. After an intended change, run `UPDATE_BASELINE=1 bun run test` and review the file's diff: it has one state or move per line. The Compare tab shows the same comparison, as "Baseline vs ...".

A baseline only covers what its limits explored, and it only notices what a screen shows, not hidden Model changes.

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
| `src/explore/check.ts` | `violations`, `deadEnds` |
| `src/explore/compare.ts`, `screen.ts` | compare two versions in one environment |
| `src/explore/key.ts` | stable key for plain data |
| `src/explore/lab.ts` | the gallery |
| `src/main.ts`, `src/release/`, `src/signup/` | example programs and their `main.cases.ts` environments |
