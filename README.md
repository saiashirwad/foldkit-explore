# Foldkit Explore

Explore and compare reachable states of Foldkit programs within a declared environment and explicit limits.

A program owns its initial state, `update`, and `view`. An environment supplies starting inputs, possible user events, and Command answers. The lab applies those choices to the real program and renders the states it discovers. Command effects never execute. A complete result covers the declared environment; it does not cover every possible browser or server behavior.

## Programs own initialization

`Program<Model, Message, Input = void>` describes the application. Its pure `start(input)` returns the initial Model and optional Commands, in the same `Update.Return` shape as `update`.

```ts
import * as Atlas from './lab/atlas'
import * as Weather from './main'
import { weatherEnvironment } from './main.cases'

const weatherProgram: Atlas.Program<Weather.Model, Weather.Message, string> = {
  name: 'Weather',
  Model: Weather.Model,
  Message: Weather.Message,
  start: Weather.start,
  update: Weather.update,
  view: (model, h) => Weather.view(model, h).body,
}

const atlas = Atlas.make(weatherProgram, weatherEnvironment, {
  limits: { states: 5_000, transitions: 50_000 },
})
```

`Environment<Model, Message, Input = void>` is separate:

```ts
export const weatherEnvironment: Environment<Model, Message, string> = {
  *starts() {
    return yield* fixture('zip', { empty: '', valid: '90210' })
  },
  next,
}
```

`starts()` yields application **inputs**, not preconstructed Models. The atlas calls `program.start(input)` for each outcome and records the initial Commands at depth zero. Weather starts with a ZIP string, Signup starts with a `Plan`, and Release uses `void`. A terminal environment can omit `next`.

The original input remains available as `state.input` throughout exploration. Include any starting choice that affects future environment behavior in this input. The atlas uses `[input, model, pending command names and arguments]` as execution identity, so equal Models with different future context do not silently merge. This can retain two executions whose current screen and pending queue happen to be identical.

Reusable program and environment registrations are exported from `src/programs.ts`: `weatherProgram`, `releaseProgram`, `signupProgram`, and their corresponding environment objects. The existing `weather`, `release`, `signup`, and `signupLongContent` atlas exports remain available.

### Immutable execution data

Inputs, Models, and modeled Command arguments must be acyclic data: primitives other than symbols/functions, dense ordinary arrays, ordinary or null-prototype records, and the installed Effect `Option` instances. All own string-named data properties participate, including non-enumerable fields. Symbol fields, accessors, sparse/decorated arrays, decorated Options, and other custom objects (including custom `Equal` implementations) fail with a data path rather than silently losing behavior. Encode unsupported values into this domain explicitly.

Atlas and Comparison validate and deep-freeze this data before interning it; inputs are checked before `start` runs. Command envelopes and pending queues are shallow-frozen, while their arguments are deep-frozen. Effects are neither traversed nor executed. Update must return new data instead of mutating old data. Reference caching remains proportional to newly replaced objects, not the full Model on each step.

Execution identity preserves record property order, enumerability, and the supported prototypes, and checks equality within hash buckets. Matching and replay use `canonical()` on evidence/codec outputs: it intentionally sorts record keys and normalizes enumerability and ordinary versus null record prototypes, but retains absent fields, `undefined`, `NaN`, signed zero, and Option meaning. Programs and environments must not depend on reference identity, aliasing, descriptor writability/configurability, mutable prototypes, proxy traps, or hidden external state. There is no user-supplied execution abstraction; visual grouping never merges concrete executions.

## Model one next step

`next(state)` enumerates **one transition**, not a whole scenario. `NextState<Model, Message, Input>` contains the current `model`, `pending` Commands, original `input`, and named view-derived `interactions` when the environment supplies an `inputs` domain.

```ts
function* next(state: NextState<Model, Message>): Choices<Transition<Message>> {
  const kind = yield* fixture('next', { user: 'user', response: 'response' })
  if (kind === 'user') {
    const typing = {
      typed: Message.UpdatedZipCodeInput({ value: '90210' }),
      cleared: Message.UpdatedZipCodeInput({ value: '' }),
    }
    const actions = AsyncData.isPending(state.model.weather)
      ? typing
      : { ...typing, submitted: Message.SubmittedWeatherForm() }
    return send(yield* fixture('move', actions))
  }

  const request = yield* fixture('pending', pendingRequests(state, FetchWeather))
  if (request.command.args.zipCode === '') {
    return answer(request, Message.FailedFetchWeather({ error: 'Zip code required' }))
  }
  return answer(request, yield* fixture('result', {
    succeeded: Message.SucceededFetchWeather({ weather: weatherData }),
    failed: Message.FailedFetchWeather({ error: 'Location not found' }),
  }))
}
```

Import `Environment`, `NextState`, `Transition`, `send`, `answer`, and `pendingRequests` from `src/lab/atlas.ts`; `Choices` and `fixture` come from `src/lab/fixture.ts`. The full Weather environment is in `src/main.cases.ts`.

- `fixture(name, alternatives)` offers a named choice. Ordinary control flow decides which later choices exist; `yield*` composes reusable generators.
- An empty fixture prunes its path. An empty pending queue removes the response branch while leaving user actions available.
- An early return completes a transition without reaching later fixtures. An empty ZIP above has one failure answer and no success/failure fixture.
- `send(message)` describes a `Move` and preserves the pending queue. This constructor is distinct from the live interaction method `atlas.interact(state, message)`.
- `pendingRequests(state, Definition)` offers every matching pending occurrence, keyed by its zero-based queue position, with typed arguments. Command definitions must have unique names within a program.
- `answer(request, message)` consumes exactly the chosen occurrence, including repeated references to the same Command. Foreign or invalid occurrences are rejected. New Commands from `update` are appended to the remaining queue.
- Scheduling belongs in `next`: offer every pending occurrence or deliberately restrict the choice. There is no hidden scheduler.

Choices must be deterministic and free of side effects. `outcomes(choices)` is an unbounded convenience iterator of completed outcomes; a fully pruned tree can still do substantial work before it returns. Search engines instead consume `enumerate(choices)`, which yields one replay advancement or sibling-selection checkpoint at a time and retains only one sibling cursor per reached fixture, not a copied path for every sibling. Calling its `return()` releases the active generator. Neither helper replays application history. A fixture name may appear only once along a path.

The Weather environment explores both `submit → clear → answer` and `submit → answer → clear` without hard-coding either scenario. Exclude events only when they cannot happen or are deliberately outside the model. Properties should report undesirable reachable behavior, rather than having the environment prune away the evidence.

## Bounded, resumable exploration

```ts
const reached = atlas.reach(4, 'breadth')
const deeper = atlas.reach(5, 'breadth')
const wider = atlas.reach(5, 'breadth', {
  states: 10_000,
  transitions: 100_000,
})
```

The default limits are 5,000 execution states, 50,000 enumerated alternatives, and 1,000,000 enumeration work units. The optional `enumerationWork` allowance is separate from `transitions`. Limits are non-negative safe integers. `reach(depth, search?, limitsOverride?)` takes **absolute limits**; repeated calls do not silently add another budget.

| Result status | Meaning |
| --- | --- |
| `complete` | Starting choices and reachable successor work were exhausted under the selected search. |
| `depth-limit` | The depth frontier remains, or Random left starting or successor work unsampled. |
| `state-limit` | The next execution state could not be admitted within the state cap. |
| `transition-limit` | The enumerated-alternative work allowance was consumed before exhaustion was established. |
| `enumeration-limit` | Fixture replay/branch work was consumed before enumeration exhaustion was established. |

`reached.counters` reports:

- `states`: distinct execution states included in this result;
- `transitions`: enumerated starting **and** next-step alternatives;
- `starts`: the starting-alternative subset of `transitions`;
- `enumerationWork`: checkpointed fixture traversal work, including branches that yield no outcome.

`counters.enumerationWork` counts checkpointed enumerator advances, including replayed fixture visits, completed outcomes, sibling selections/exhaustion, empty leaves, and the final completion probe. Atlas charges retained prefixes against each run's absolute allowance without redoing them; Comparison accumulates the same units across `resume`. Exact exhaustion can conservatively remain limited until a further unit establishes completion. Option names are still collected once per reached fixture, and each application advancement can do arbitrary work. Completed alternative counters retain their existing meanings.

Repeated alternatives count as work even if their resulting Models and pending queues merge into one state. State and transition limits are checked inside start and successor enumeration, rather than between entire breadth-first layers.

Each source retains its iterator and yielded alternatives. An arrival prepared just before a state or depth stop remains buffered; resuming admits that same arrival without calling `start` or `update` again. A result exactly at its transition limit may conservatively report `transition-limit` until a larger allowance lets the iterator establish exhaustion.

`unfinishedWork` identifies unresolved starting work, the number of execution states awaiting expansion, and the number of buffered arrivals awaiting admission. These are known unfinished items, not a prediction of how many outcomes an unenumerated generator contains. The limits bound admitted states, enumerated alternatives, and fixture traversal checkpoints; they are not a process-memory cap or a timeout for arbitrary code inside a generator. One Model can itself be large, and the atlas retains caches from earlier searches and live interactions.

The search modes are breadth-first, depth-first, and 32 deterministic seeded random walks. Depth-first revisits an execution discovered later on a shorter path. Both exhaustive traversals reach the same bounded-depth state set when their work and state allowances suffice. Random samples paths and can leave work unexplored even when sampled states are terminal.

`atlas.knownSuccessors(state)` reads the already admitted successor prefix without doing exploration. `atlas.successors(state, limitsOverride?)` explicitly explores that state's alternatives, bounded by the atlas limits by default; its local state allowance includes the source state. A larger explicit override resumes it. `atlas.successorStatus(state)` is `unseen`, `partial`, or `complete`. Passive rendering and `describe` use cached prefixes instead of completing successor generators.

## Observations and view-driven exploration

Signup's environment supplies initial plans, a finite `Username` input domain, and a `next` generator that chooses user interactions or Command answers. `src/lab/interactions.ts` uses the public `foldkit/scene` API to render the real view, click enabled buttons, and type configured values into editable textboxes. A recording update captures each emitted Message; the atlas applies the application's real update only after the environment selects that interaction.

`inspect(view, model, inputs, encodeMessage?)` returns a structured `Screen` and interactions `{ key, label, message }`. The screen contains tag, text, attributes, properties, classes, dataset, style, and children. `atlas.observe(state)` exposes:

```ts
type Observation = {
  screen: Screen
  actions: ReadonlyArray<{ key: string; label: string }>
  pending: ReadonlyArray<{ name: string; args: unknown }>
}
```

Action identity is the canonical encoded Message, rather than button text or DOM position. Labels remain readable separately. Renaming or moving a button therefore does not by itself turn the event into a removed action and an unrelated added action. `canonical()` sorts record keys and preserves supported values that JSON can omit or collapse, including `undefined` and Effect `Option`. Unsupported reference values require a data encoding. Pending Command descriptions preserve every occurrence.

The gallery groups equal rendered markup for view-driven environments and explicitly uses equal Models for other environments. Grouping never changes execution identity: two executions with different pending work or initial context can share one preview while retaining separate behavior. Filters refer to the state's first-discovery trace, not every possible path to it.

The Scene probe supports enabled buttons, including form submission, and configured editable textboxes. It does not automatically enumerate selects, checkboxes, links, keyboard or pointer gestures, subscriptions, or custom control protocols. A single interaction that emits multiple Messages is rejected. Mount-backed views are unsupported and fail the Scene probe. Weather and Release model their user Messages explicitly. Supplying `inputs` makes view interactions available to `next`; it does not automatically add a second transition source.

Command effects never run, and declared Command argument schemas are not revalidated. Answers are checked against the program's Message schema, not a per-Command result schema. The environment is responsible for realistic responses. Signup permits any pending occurrence to finish and chooses answers independently; it models no persistent server or fairness assumption.

## Compare two versions under one environment

`compare` constructs fresh before and after executions. It does not inspect or mutate gallery atlas state, so earlier card interactions cannot change the comparison's starting point.

```ts
import { compare } from './lab/compare'
import { signupEnvironment } from './programs'
import { properties } from './signup/properties'
import { original, retryRemoved } from './signup/variants'

const comparison = compare({
  before: original,
  after: retryRemoved,
  environment: signupEnvironment,
  properties,
  limits: { depth: 8, states: 5_000, transitions: 20_000 },
})
```

The programs may use different Model types. They must share compatible Input and Message types and encodings, and the shared environment must handle both Models. The environment enumerates each start once; both programs run their own `start` for that input. Initial Models, screens, actions, pending Commands, and newly issued Commands are observable at depth zero.

The comparator explores pairs breadth-first. It matches Moves by canonical encoded Message. It matches Answers by Command name and arguments, the selected occurrence among identical requests, and the encoded response Message. Array positions remain replay evidence rather than cross-version Command identity.

Findings distinguish rendered content, added or removed actions, pending work, newly issued Commands, added or removed environment events, and property failures. Equivalent findings are grouped while retaining concrete examples and a shortest explored trace. A Model difference by itself is not an appearance or behavior finding; observations and properties determine what is reported.

When only one version offers an event, the comparison applies it on that side and records the real successor. That branch stops there. It does not invent a successor on the other side or claim to explore later behavior down an unmatched branch. Missing-event findings require both sides' alternative enumeration to finish, so an unfinished iterator is not mistaken for an absent action. Duplicate semantic event keys within one state's environment are rejected as ambiguous; offer each semantic event once.

`comparison.status` uses the atlas status vocabulary plus `pair-limit`. The required comparison limits are `depth`, `states` per side, and `transitions`; optional `pairs` defaults to the state limit and `enumerationWork` defaults to 1,000,000. Comparison transition work counts each shared starting alternative once and each before/after next-step alternative separately. Its counters report starts, states on each side, pairs, total alternatives, next-step alternatives on each side, and separate enumeration work (shared starts once and both sides' fixture traversal separately).

`comparison.unfinishedWork` lists the remaining start or pair enumerations. `comparison.resume(limits)` continues retained work; every supplied limit must be at least its previous value. Create a fresh comparison to use smaller limits. `comparison.replay(trace)` constructs fresh program executions from the recorded choices, verifies the events and recorded evidence, and returns the replayed trace.

“No differences found” in an incomplete comparison describes only the explored executions. Even a complete result remains relative to this environment, observation format, and event-matching contract. This is bounded synchronous UI comparison, not temporal-logic checking, a liveness proof, or a universal equivalence proof.

## Properties, snapshots, and visual limits

Pass typed `Property<Model, Message>` predicates to `Atlas.make(program, environment, { properties })`. Signup's predicates live in `src/signup/properties.ts`. `atlas.check(depth, limitsOverride?)` uses breadth-first paths and returns one shortest explored counterexample per failing property, independently of the gallery's selected search or earlier live-click discovery. It stays within the same exploration limits; inspect the matching `atlas.reach(depth, 'breadth', limitsOverride).status` when interpreting coverage. A passing bounded check does not prove every execution safe.

The `.atlas` snapshots record Models, pending Commands, readable transition labels, and the search status at fixed depths. They now preserve initial input context and only print explored transition prefixes. This changes execution counts and traces compared with the earlier setup-based snapshots. Regenerate them intentionally with `bun run test -- -u` and review the diff.

Snapshots are behavior baselines, not screenshots. Structured observations detect view content and markup changes, but do not measure computed styles, layout geometry, browser rendering, or external stylesheet changes that leave markup intact.

Select **Signup · long content**, use BFS, and set depth **4** for the long-username stress environment. It reuses Signup's program, starts, and next-step model with one long input value. The Confirm state's address can replay that execution, including pending work. See [the existing viewport inspection notes](docs/visual-inspection.md) for the browser comparison and its limits. A scaled gallery card is not a device viewport.

The comparison examples in `src/comparisons.ts` cover a removed retry, changed heading, missing stale-response guard, duplicate submissions, an equivalent helper refactor, and identical programs. Their implementation is in `src/signup/variants.ts`; review them through the lab's comparison mode.

## Run it

```bash
bun install
bun dev                  # open /lab.html; / is the plain Weather app
bun run test
bun run typecheck
bun run lint
bun run build
```

The lab lets you filter by trace choices, change search and depth, interact with previews, inspect and answer pending Commands, rewind a trace, and pin an execution. Comparison mode shows grouped findings, before/after previews, concrete traces, replay verification, and incomplete-search status.

## Layout

| Path | Role |
| --- | --- |
| `src/lab/fixture.ts` | Lazy named choices and deterministic replay |
| `src/lab/identity.ts`, `src/lab/canonical.ts` | Execution hash-consing and semantic matching keys |
| `src/lab/atlas.ts` | Program/environment contracts, bounded graph exploration, properties, and addresses |
| `src/lab/interactions.ts`, `src/lab/observation.ts` | Scene probing and structured observations |
| `src/lab/compare.ts` | Fresh paired exploration, findings, limits, and replay |
| `src/lab/lab.ts`, `src/lab/review.ts` | Gallery and comparison views |
| `src/programs.ts`, `src/comparisons.ts` | Program, environment, atlas, and comparison registrations |
| `src/main.cases.ts`, `src/release/main.cases.ts`, `src/signup/main.cases.ts` | Starting inputs and next-step environments |
| `src/signup/properties.ts`, `src/signup/variants.ts` | Signup properties and comparison examples |
| `src/lab/*.atlas` | Fixed-depth behavior snapshots |
