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

Execution identity preserves record property order, enumerability, and the supported prototypes, and checks equality within hash buckets. Matching and compact navigation replay use `canonical()` on codec outputs: it intentionally sorts record keys and normalizes enumerability and ordinary versus null record prototypes, but retains absent fields, `undefined`, `NaN`, signed zero, and Option meaning. Programs and environments must not depend on reference identity, aliasing, descriptor writability/configurability, mutable prototypes, proxy traps, or hidden external state. There is no user-supplied execution abstraction; visual grouping never merges concrete executions.

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

## Bounded replay and portable evidence

`atlas.resolve(address, options?)` and `resolveSteps` replay only the recorded decisions into that explicitly owned Atlas. They do not search or publish sibling starts or transitions. Start must be first; subsequent hops must be Move, Answer or Event. Every fixture decision must be consumed, and every transition now carries its encoded Message. Old label-only transition addresses are rejected rather than treated as semantic evidence. A replay can retain its selected prefix when interrupted; it does not charge the unrelated exploration counters.

Replay options are `{ limits: { hops, work }, signal?: AbortSignal }`. Defaults are 1,000 hops (including Start) and 1,000,000 total iterator advancements, including completion probes. The checkpointed form composes with the Command runner; `return()` closes suspended generators. `ReplayDivergenceError.reason` distinguishes changed choices, kinds, Messages, occurrences, identity and evidence. `ReplayLimitError` and `ReplayCancelledError` are separate failures, never a successful verification. Message codecs must faithfully round-trip the supported semantic value; a codec that collapses `-0` to `0`, for example, is explicitly rejected for that value.

Addresses remain navigation data, not portable certificates: they cannot establish unchanged initialization, request occurrence, output, observations or program identity. Use a native evidence artifact for those checks:

```ts
import { parseEvidence, serializeEvidence } from './lab/evidence'

const identity = {
  program: 'signup@<revision>',
  environment: 'signup-cases@<revision>',
  inputEncoding: 'plan@1',
  modelEncoding: 'signup-model@1',
  messageEncoding: 'signup-message@1',
}
const artifact = atlas.evidence(state, identity)
const serialized = serializeEvidence(artifact)
const replayed = atlas.replayEvidence(parseEvidence(serialized), identity, {
  limits: { hops: 100, work: 10_000 },
})
```

Supply explicit, versioned program/environment and encoding identifiers; they are caller assertions, not automatically computed source hashes or a code loader. Replay requires the corresponding Program and Environment. `evidence(state, identity)` passively exports that state's first-discovery trace. `replayAddressSteps(address, identity, options?)` explicitly records a selected path, preserving repeated/self-loop steps; `replayEvidenceSteps` is the cooperative fresh-verification form. Evidence replay owns and disposes a fresh Atlas and does not publish into the original session or alter earlier check reports.

The version-1 `foldkit-explore/evidence` artifact contains no session-local state/pair IDs. It checks each input, raw and codec-encoded Model and Message, initial Commands, selected request name/arguments/index/duplicate occurrence, newly issued and remaining Commands, and structured observation. Commands are only descriptions; their effects never execute. The artifact's `foldkit-data/v1` tagged codec, not ordinary JSON, preserves absent versus present-undefined fields, Option Some/None, signed zero, NaN/infinities, bigint, supported record prototypes, own property order and enumerability (including `Some.value`). It rejects the same lossy representations as execution identity. Event codecs must also round-trip their supported own data representation; native evidence cannot repair a lossy application codec.

Schema validation, JSON parsing, and an individual wide data/fixture/codec operation remain non-preemptible, as does arbitrary application code between yields. The work allowance is not a hard wall-clock or memory cap. This native format is not Quint ITF; an ITF action/choice mapping and explicit state projection remain a separate interoperability adapter.

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

`comparison.unfinishedWork` lists the remaining start or pair enumerations. `comparison.resume(limits)` continues retained work; every supplied limit must be at least its previous value. Create a fresh comparison to use smaller limits. `comparison.replay(trace, replayOptions?)` constructs fresh program executions from the recorded choices, verifies the events and recorded evidence, and returns the replayed trace. `replaySteps` exposes cooperative checkpoints. Its default total replay work allowance is the comparison's `enumerationWork` limit, including all fixture work needed to verify an absent counterpart; hop/work overrides and cancellation use the same replay options as Atlas.

“No differences found” in an incomplete comparison describes only the explored executions. Even a complete result remains relative to this environment, observation format, and event-matching contract. This is bounded synchronous UI comparison, not temporal-logic checking, a liveness proof, or a universal equivalence proof.

## Properties, snapshots, and visual limits

Pass typed `Property<Model, Message>` predicates to `Atlas.make(program, environment, { properties })`. Every property requires a stable, unique `id`, a display `name`, and at least one state or transition predicate. Duplicate labels are allowed; duplicate identifiers and predicate-free registrations are rejected by both Atlas and Comparison. Signup's predicates live in `src/signup/properties.ts`.

`atlas.check(depth, limitsOverride?)` returns a frozen, versioned `CheckReport`, not a violations array. It embeds that check's exact BFS depth, absolute limits, admitted starts/states/edges, enumeration status, frontier, counters, and modeling assumptions. `report.violations` preserves one shortest explored counterexample per property ID, independent of earlier live-click discovery. Later searches, clicks, or replay cannot change it. The inspector renders the report's own coverage, never the gallery's DFS/Random status.

Per-property verdicts are `counterexample`, `inconclusive` (no counterexample within limits), `complete` (only in the declared environment), `not-exercised`, or `error`. Errors take precedence but retain any observed counterexample. State and transition counts separately track considered, applicable, and evaluated predicates. Throwing applicability/predicates carry their location and diagnostic rather than becoming false predicates. Initialization/update/environment failures produce `model-error` coverage with the admitted prefix and an error verdict; ordinary `reach` continues to throw these failures. An empty environment or zero allowance cannot produce a pass. Consumers must choose their own explicit policy for incomplete, unexercised, or error results.

Optional `stateApplies` and `transitionApplies` make conditional applicability explicit; a Boolean implication alone does not establish that its antecedent was exercised. Reports retain a shortest applicability witness and distinguish observed, unobserved within limits, and unreachable in the completed declared graph. Transition predicates receive a fourth `TransitionEvidence` argument with the kind, selected request index/duplicate occurrence, and the actual newly issued Commands. Signup submission checks issuance, not whether a matching request happens to be pending. Comparison uses the same IDs, applicability and issuance evidence, retaining shared before/after failures without calling them regressions.

The `.atlas` snapshots record Models, pending Commands, readable transition labels, and the search status at fixed depths. They now preserve initial input context and only print explored transition prefixes. This changes execution counts and traces compared with the earlier setup-based snapshots. Regenerate them intentionally with `bun run test -- -u` and review the diff.

Snapshots are behavior baselines, not screenshots. Structured observations detect view content and markup changes, but do not measure computed styles, layout geometry, browser rendering, or external stylesheet changes that leave markup intact.

Select **Signup · long content**, use BFS, and set depth **4** for the long-username stress environment. It reuses Signup's program, starts, and next-step model with one long input value. The Confirm state's address can replay that execution, including pending work. See [the existing viewport inspection notes](docs/visual-inspection.md) for the browser comparison and its limits. A scaled gallery card is not a device viewport.

The comparison examples in `src/comparisons.ts` cover a removed retry, changed heading, missing stale-response guard, duplicate submissions, an equivalent helper refactor, and identical programs. Their implementation is in `src/signup/variants.ts`; review them through the lab's comparison mode.

## Run it

```bash
bun install --frozen-lockfile
bun dev                  # open /lab.html; / is the plain Weather app
bun run test
bun run typecheck
bun run lint
bun run build
```

The lab lets you filter by trace choices, change search and depth, interact with previews, inspect and answer pending Commands, rewind a trace, and pin an execution. Comparison mode shows grouped findings, before/after previews, concrete traces, replay verification, and incomplete-search status.

## UI execution and session ownership

Gallery exploration, property checks, inspector probing, live updates and fresh replay run only in declared Foldkit Commands. Views render immutable schema-defined snapshots; they never read or advance a live Atlas/Comparison. Preparing an update only changes the UI Model and declares Commands.

The shared Effect runner advances at most 128 checkpoints per Command and schedules a sleep before each chunk, so browser input can run between chunks. Fixture traversal, selected-decision replay, property checking and gallery snapshot/group construction expose advancement checkpoints. The Model distinguishes running progress, completed work, cancellation, invalid program Models and unexpected defects. Completion means the requested **bounded** analysis finished, not that an incomplete search proved a property or equivalence. Cancelled work is never displayed as a successful check.

Every progress/completion carries a monotonically increasing run identifier. Superseded messages are ignored; old queued Commands cannot revive a cancelled session. Each UI mode owns one session, not a graph per depth. Comparison depth increases reuse that session; decreases start fresh. The gallery can reuse its source prefixes for any search/depth. Switching programs/scenarios, resetting, cancelling or leaving a mode closes its Effect scope and iterators. Runtime resource-Layer finalizers close remaining sessions when the application ends. Saved gallery positions/pins remain Addresses and are replayed by Commands when returning to a fresh session.

`createComparison(options)` creates an unstarted session (`running` status). `advance(checkpoints)` returns whether the requested limits have finished, and `setLimits` accepts only nondecreasing bounds. The synchronous `compare`/`resume` APIs still run to their declared limits. Atlas's synchronous APIs likewise remain available to headless callers; the UI uses their checkpointed generator counterparts. `dispose()` releases engine iterators and caches.

Cooperative scheduling cannot interrupt arbitrary non-yielding application code, a single wide fixture/Model/codec operation, or final snapshot validation. It is not a hard wall-clock or memory limit. Typed replay allowances bound total selected replay and counterpart-absence work; portable evidence remains separate from the compact UI Addresses and runner snapshots.

## Validation and headless policy

`.github/workflows/validation.yml` runs tests, lint, the declared TypeScript compiler and production build from `bun.lock`, using Bun **1.4.0** and Node **24.19.0**. It does not substitute a different compiler to obtain a pass. A separate job installs the locked Playwright **1.64.0** Chromium revision and runs `bun run test:browser`. The browser smoke exercises the real `/lab.html` entry point plus a deliberately large pruned fixture: cancellation, reset, depth/mode controls, live interaction, inspection, comparison previews and fresh replay. It uploads screenshots, logs and a JSON result. This is browser conformance, not computed-accessibility, cross-browser or screenshot-diff coverage.

```sh
bun run check:analysis > check-report.json
bun run check:analysis --scenario=signup --depth=8 > signup-report.json
bunx --no-install playwright install chromium
bun run test:browser
```

The headless command emits one JSON artifact containing the exact `CheckReport` in the lossless native tagged data encoding, plus a readable coverage/property summary. Default `safe` is a finite safety smoke, not a claim about Signup. Exit codes are **0** complete and exercised, **1** counterexample, **2** incomplete, **3** execution/evaluation error, and **4** unexercised. Errors take precedence over counterexamples; the report retains both. No registered properties, empty starts, bounded absence of violations and cancellation are never success. Signup normally remains incomplete at depth 8 and therefore exits 2. `counterexample`, `incomplete`, `error` and `empty` scenarios exercise the failure policy in fresh-process tests. JSON is the transport; decode `report` with `decodeEvidenceData` before validating `CheckReport`.

`finite-oracle.ts` is a deliberately independent transition-table checker: it imports no production identity, fixture enumeration, traversal or matching code. Fixed seeds and small explicit protocol fixtures cover multiple/duplicate starts, diamonds, self-loops, revisited/distinct/duplicate edges, terminal states, selected duplicate requests, bounded resumption, run isolation and one-sided paired stops. Production results are compared by independently encoded input/Model/pending data, not session IDs. Mutation-sensitivity tests reject lost revisited edges, wrong request consumption and false frontier completion. These oracle tests run in Vitest's Node environment; existing Scene tests still use DOM simulation.

Comparison's `joinOperations` counts physical event-map membership/lookups during duplicate checking, matching, reconciliation and application. It is not `transitions`, fixture work, hashing time or wall-clock cost. Width tests require exactly `8 × width` probes for matched fanouts. A 16-event fanout with one shared before node measures **289 before / 33 after generator invocations**, **272 before / 16 after updates**, **18 inspections**, **288 logical side-edge predicate evaluations**, and **1,408 join probes**. Physical generator invocations include fixture replays. This demonstrates pair-local repeated enumeration/update work while inspection already shares: side-local event/application caching is a justified follow-on, but must retain all logical paired-edge checks. No cache redesign is included here. Fixture enumeration's independent work-count regressions remain in `enumeration.test.ts`.

Quantitative API cross-checks remain a follow-on to #11, which has no public metric queries yet. The browser smoke does not implement #13's full runtime-conformance contract. Complete checks remain relative to declared environments and supported semantics, never universal UI equivalence.

## Layout

| Path | Role |
| --- | --- |
| `src/lab/fixture.ts` | Lazy named choices and deterministic selected replay |
| `src/lab/replay.ts` | Shared hop/work allowances and typed replay failures |
| `src/lab/evidence.ts`, `src/lab/evidence-data.ts` | Versioned portable evidence and lossless native data codec |
| `src/lab/identity.ts`, `src/lab/canonical.ts` | Execution hash-consing and semantic matching keys |
| `src/lab/atlas.ts` | Program/environment contracts, bounded graph exploration, properties, and addresses |
| `src/lab/interactions.ts`, `src/lab/observation.ts` | Scene probing and structured observations |
| `src/lab/compare.ts` | Fresh paired exploration, findings, limits, and replay |
| `src/lab/analysis-runner.ts`, `src/lab/analysis-data.ts` | Scoped chunk execution and immutable UI result schemas |
| `src/lab/lab.ts`, `src/lab/review.ts` | Gallery and comparison Models, Commands and pure views |
| `src/programs.ts`, `src/comparisons.ts` | Program, environment, atlas, and comparison registrations |
| `src/main.cases.ts`, `src/release/main.cases.ts`, `src/signup/main.cases.ts` | Starting inputs and next-step environments |
| `src/signup/properties.ts`, `src/signup/variants.ts` | Signup properties and comparison examples |
| `src/lab/*.atlas` | Fixed-depth behavior snapshots |
