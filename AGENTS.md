# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: false

## Project Notes

### What this is

Foldkit Explore shows reachable states of a Foldkit program within a declared environment and explicit limits. It also compares two program versions under one shared environment. It began as Branch Lab, a React prototype (`~/code/eva-idea`) in which a component's case generator yielded named choices (`fixture()`) and a replay search rendered every combination. Here the same choice language drives a real Elm-style program. Because `update` is pure and Models are plain data, the lab steps states directly instead of replaying them. It explores _time_ (moves and Command answers) as well as setup, and works toward model checking for UIs.

The person driving this reads every line. Keep changes small, idiomatic and easy to review. Ask before changing a direction that has already been settled.

### Run

```sh
bun dev                 # open /lab.html (index.html is the plain weather app)
bun run test            # vitest; rewrites src/lab/*.atlas when called with -u
bun run typecheck
bun run lint            # oxlint with the Foldkit plugin; its rules are strict and right
bunx oxfmt src          # format
```

### Vocabulary

- **fixture**: `yield* fixture('name', { option: value })`. A named choice. Control flow decides whether a fixture is reached, and an empty fixture prunes its path.
- **Choices<T>**: a generator of fixtures that returns a `T`. `outcomes()` is an unbounded convenience generator of `{ decisions, value }`; bounded engines consume `enumerate()` checkpoints instead. Each checkpoint advances replay or one sibling cursor, including pruned paths.
- **Program<Model, Message, Input = void>**: the application's `name`, Model and Message codecs, pure `start(input)`, `update`, and `view`. The program owns initialization and initial Commands. Properties and environment choices do not belong on Program.
- **Environment<Model, Message, Input = void>**: `starts(): Choices<Input>`, optional finite view `inputs`, and optional `next`. Starting choices return inputs, never preconstructed Models or setup objects.
- **NextState**: current Model, pending Commands, original `input`, and semantic-keyed view-derived `interactions` (empty without an `inputs` domain). Carry starting choices that affect future environment behavior in `input`.
- **next**: `(state: NextState<Model, Message, Input>) => Choices<Transition<Message>>`. It describes one possible next step, not a whole scenario. Empty fixtures prune paths; early returns produce transitions.
- **Move / Answer**: `send(message)` preserves the pending queue; `answer(request, message)` consumes exactly the selected occurrence. Both use the real update. `pendingRequests(state, CommandDefinition)` supplies typed occurrences as a record for a fixture. Scheduling restrictions belong in the environment.
- **Atlas** (`src/lab/atlas.ts`): one program/environment pair's memoized execution graph, constructed with `make(program, environment, { properties?, limits? })`.
- **Observation**: structured `screen`, available `actions` with separate semantic keys and readable labels, and all pending Command descriptions. `atlas.observe(id)` exposes it.
- **Comparison**: fresh breadth-first paired exploration of before and after Programs under one Environment, with grouped findings, concrete examples, replayable traces, and explicit incomplete status.
- **State id**: `S1`, `S2`… in discovery order. Only valid within one atlas session; comparison execution and pair ids are likewise local.
- **Address**: a list of hops (kind, decisions, optional encoded Message) from a start to a state. The lab's Model stores addresses, never atlas ids.
- **Card / slot / home**: a card is a slot in the grid. Its home is its original state; it can be moved to other states. A pin is an extra slot.

### Layout

| Path | Role |
| --- | --- |
| `src/lab/fixture.ts` | `fixture`, lazy `outcomes`, `Decision` schema |
| `src/lab/identity.ts` | Hash-consing: equal execution values share canonical references |
| `src/lab/canonical.ts` | Stable data keys for encoded Messages, Commands, and observations |
| `src/lab/atlas.ts` | Program/Environment contracts, transitions, bounded exploration, properties, addresses, and text snapshots |
| `src/lab/interactions.ts`, `src/lab/observation.ts` | Public Scene probing, structured screens, semantic action keys, and pending Command descriptions |
| `src/lab/compare.ts` | Fresh before/after execution, event matching, grouped findings, limits, and replay |
| `src/lab/lab.ts`, `src/lab/review.ts` | The gallery and comparison review Foldkit programs |
| `src/lab/lab.css` | Lab styles inside `@layer components` |
| `src/lab/entry.ts`, `lab.html` | Lab page, with devtools off |
| `src/programs.ts`, `src/comparisons.ts` | Typed program/environment objects, atlas instances, and comparison examples |
| `src/main.cases.ts`, `src/release/main.cases.ts`, `src/signup/main.cases.ts` | Starting inputs and next-step environments |
| `src/signup/properties.ts`, `src/signup/variants.ts` | Signup invariants and deliberate comparison variants |
| `src/lab/*.atlas` | Fixed-depth behavior snapshots; changes to execution context or explored prefixes affect their diffs |

### How exploration works

- **Initialization.** Environment starts yield Input. The real `program.start(input)` supplies Model and optional Commands; both are present at depth zero. Weather exports a pure `start(zipCodeInput)` and delegates runtime initialization to it. Release and Signup expose their existing pure `init` as Program.start.
- **Exploration.** `reach(depth, search?, limitsOverride?)` supports breadth-first, depth-first, and 32 deterministic random walks. Successors come only from `environment.next(state)`. Signup offers every matching pending occurrence. Scene-derived interactions are an optional choice source, not a separate exploration path. Depth-first revisits shorter paths; random traversal can leave starts or branches unsampled. `check` always uses breadth-first paths.
- **Merging.** Atlas identity is `identity.of([input, model, pending names and args])`. One atlas owns one fixed environment. Keeping Input in identity prevents equal current states with different future context from merging. Screen grouping is separate and never discards those executions. Comparison execution identity also retains the initial choice path.
- **Live clicks.** `atlas.interact(id, message)` validates with the program Message schema and records an encoded `Event` hop. The exported `send(message)` still constructs an environment Move; it is not an atlas method.
- **Limits.** `make` defaults to `{ states: 5_000, transitions: 50_000, enumerationWork: 1_000_000 }`. Enumeration work is distinct from completed alternatives and includes replay advances, sibling selection/exhaustion, and the completion probe. Both `reach` overrides and bounded `successors(id, limitsOverride?)` use absolute allowances, not an additional budget per call. A direct successor probe includes its source state in its local state count.
- **Work accounting.** `reach().counters.transitions` counts all enumerated starting and next-step alternatives, even ones that merge. `counters.starts` is the starting subset; `counters.states` is the returned execution count. Sources retain checkpointed iterators, cumulative work per yielded outcome, and prepared arrivals. Atlas recharges retained prefixes against each run's absolute enumeration allowance; Comparison accumulates the same checkpoint categories across resume. Resumption does not drop lookahead or reapply a buffered update.
- **Status.** `reach().status` is `complete`, `depth-limit`, `state-limit`, `transition-limit`, or `enumeration-limit`. Exact work exhaustion can conservatively remain limited until another iterator step establishes completion. `unfinishedWork` reports unresolved starts, execution frontiers, and buffered arrivals; it does not estimate unknown generator cardinality.
- **Passive reads.** `knownSuccessors(id)` never expands a source. `successorStatus(id)` distinguishes unseen, partial, and complete alternatives. `describe` and bounded property checking must not eagerly finish successor generators. Keep passive views on cached prefixes; use bounded successor probing for an explicit inspector action.
- **Cost.** Limits bound admitted states, yielded alternatives, and enumeration checkpoints, not process memory or arbitrary generator computation time. A fixture still collects its option names at its width; sibling paths are allocated incrementally. `outcomes()` is unbounded; cooperative runners must consume `enumerate()` directly and close it on disposal. Caches persist across searches and live interactions. Identity cost is proportional to objects update replaced, each at its own width. A changed 10,000-element array is still rescanned. Do not claim O(change).

### How comparison works

`compare({ before, after, environment, properties?, limits })` takes two Programs with compatible Input and Message types/encodings and one Environment that can handle both Model types. It constructs fresh executions; never compare mutable gallery atlases or share their live interaction history.

- Limits require `depth`, `states` per side, and `transitions`; `pairs` is optional and defaults to `states`. Status adds `pair-limit`. Total work counts each shared start once and each side's next-step alternatives separately.
- `resume(limits)` retains iterators and buffered work. All limits must be nondecreasing; start a fresh comparison for smaller limits.
- Match Moves by canonical encoded Message. Match Answers by Command name/arguments, occurrence among identical requests, and encoded response. DOM indexes and readable labels are not event identities. Reject duplicate semantic keys in one execution's environment.
- Compare structured screen content, actions, pending Commands, newly issued Commands, available events, and properties. A different Model alone is not a UI finding. Keep concrete examples and shortest explored traces within grouped findings.
- An unmatched event is applied on the side that offers it and its real successor is recorded. That branch stops immediately; never invent or explore a fake counterpart. Finish both event enumerations before declaring a missing event.
- `replay(trace)` restarts both programs and replays recorded fixture decisions, then checks recorded events and evidence. Initial Commands and observations matter at depth zero.
- No findings in an incomplete search is not equivalence. Complete always means complete for the declared environment and supported observations, not a liveness or universal UI proof.

### Conventions beyond FOLDKIT.md

- **No type assertions.** Lint forbids `as`. `fixture` is typed by looking the replayed value up among its own cases. `pendingRequests` uses a localized name-based type predicate to recover a definition's typed arguments, relying on unique Command names within a program (Foldkit's matching contract).
- **Effect v4 specifics:**
  - `Hash.combine` is curried only.
  - `Predicate.isObject` excludes arrays.
  - `Array.filterMap` takes a `Result`; use `Array.getSomes` for Options.
  - `Array.modify` returns an `Option`.
- **Lazy views.** `createKeyedLazy` slots and the view functions passed to them live at module scope, and the arguments must be primitives or stable references. Otherwise the memo never hits; `caseView` takes `slot`, `home` and `state` for this reason.
- **`Got*` naming.** `Got*` Messages are reserved for typed Submodels. A case's Message is untyped, so the lab uses `InteractedWithCase`.
- **Styling.** The lab chrome must never restyle a program's view. All lab CSS sits in `@layer components`, below Tailwind utilities. The one deliberate exception is the unlayered `.case-preview > * { min-height: 0 }`, so page-sized views take their natural height in cards.
- **Design direction (from the user).** One clean top bar: program picker, filters, count, search (BFS/DFS/Random), depth, Reset. No brand, no devtools overlay. Preview frames show only application views, with a neutral Inspect button outside each frame. State ids, execution counts, traces, and Command answers live in the inspector; aggregate counts stay in the top bar. Prefer removing UI over adding it.

### Known issues

- View-driven environments use the public Scene driver to record Messages from enabled buttons and configured text inputs. This is a limited probe, not universal interaction introspection; Mount-backed views are unsupported. Other examples choose explicit Messages in `next`.
- The Weather view hard-codes `id="location"`, so several Weather cards trigger Foldkit's duplicate-id warning.
- A state's address is the trace by which it was first found. If a live click discovers a state before breadth-first search does, its address goes through an `Event` hop. It still resolves.
- Command definitions don't expose their declared `messages` or argument schemas. Answers are validated against the program Message schema, not a per-Command result schema. The modeled environment must describe realistic responses; unique Command names are required. Interrupts and subscriptions are not automatically modeled.

### Directions discussed

- **Additional invariants** such as dead buttons, dead ends, and stuck spinners. Typed state/transition properties and shortest explored counterexamples already exist; these extra properties are not automatically implemented.
- **Comparison across commits.** The paired Program comparison engine exists; automatic repository-version loading and CI review policy remain separate work.
- **Computed accessibility or screenshot observations.** Structured rendered markup is available now; computed accessibility trees, browser layout, and screenshots are not part of the comparison contract.
- **Pairwise coverage** across environment axes (viewport, locale, long strings) using a priority order.
- **Quint conformance**: replay Quint ITF traces through the UI. See `~/research-ideas.md`.
