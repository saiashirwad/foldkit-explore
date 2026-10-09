# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: false

## Project Notes

### What this is

Foldkit Explore shows every state a Foldkit program can reach, on one page. It began as Branch Lab, a React prototype (`~/code/eva-idea`) in which a component's case generator yielded named choices (`fixture()`) and a replay search rendered every combination. Here the same choice language drives a real Elm-style program. Because `update` is pure and Models are plain data, the lab steps states directly instead of replaying them. It explores _time_ (moves and Command answers) as well as setup, and works toward model checking for UIs.

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
- **Choices<T>**: a generator of fixtures that returns a `T`. `outcomes()` enumerates every way it can finish, by replay.
- **Setup**: what a program's `cases` generator returns: `{ model, commands?, next?, inputs? }`.
- **NextState**: the current Model, pending Commands, and named view-derived `interactions` (empty without an `inputs` domain).
- **next**: `(state: NextState<Model, Message>) => Choices<Transition<Message>>`. One generator enumerates all possible next transitions, not a whole scenario. Empty fixtures prune paths; early returns produce transitions.
- **Move / Answer**: `send(message)` preserves the pending queue; `answer(request, message)` consumes exactly the selected occurrence. Both run the real update. `pendingRequests(state, CommandDefinition)` supplies typed occurrences as a record for a fixture. Scheduling restrictions belong in `next`, not the atlas.
- **Atlas** (`src/lab/atlas.ts`): one program's memoized state graph.
- **State id**: `S1`, `S2`… in discovery order. Only valid within one session.
- **Address**: the list of hops (kind, decisions, maybe an encoded Message) from a start to a state. Stable across sessions. The lab's Model stores addresses, never ids.
- **Card / slot / home**: a card is a slot in the grid. Its home is the state it starts at, and it can be moved to other states. A pin is an extra slot.

### Layout

| Path                           | Role                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/lab/fixture.ts`           | `fixture`, `outcomes`, `Decision` schema                                                    |
| `src/lab/identity.ts`          | Hash-consing: equal values share one canonical reference                                    |
| `src/lab/atlas.ts`             | `Program`, `Setup`, `NextState`, transitions, `make`, addresses, `describe` (text snapshot) |
| `src/lab/lab.ts`               | The lab as a Foldkit program (`makeLab(atlases)`)                                           |
| `src/lab/lab.css`              | Lab styles inside `@layer components`                                                       |
| `src/lab/entry.ts`, `lab.html` | Lab page (devtools off)                                                                     |
| `src/programs.ts`              | Registers programs with `Atlas.make`                                                        |
| `src/main.cases.ts`            | Weather cases (`src/main.ts` is the untouched template example)                             |
| `src/release/`                 | Release deploy flow ported from Branch Lab's DeploymentPanel, plus its cases                |
| `src/lab/*.atlas`              | Committed snapshots of every reachable state; their git diff is a behaviour diff            |

### How the atlas works

- **Exploration.** Exploration is breadth-first in layers, memoized (`layerAt`). Successors are the outcomes of `setup.next(state)`, each applied through update. The generator chooses user Messages and pending Command answers; Signup offers every pending occurrence. Public Scene-derived interactions are an optional choice source, not a separate exploration path. The lab's Search control (`reach(depth, search)`) also offers depth-first, which revisits a state found on a shorter path so it reaches the breadth-first set at the same depth unless the budget runs out, and 32 seeded random walks of up to `depth` steps. A trace is the path on which a state was first found, so it can be longer than the shortest after a depth-first or random search; `check` stays breadth-first. See README for supported view-driven controls and scope limits.
- **Merging.** A state is keyed by `identity.of([setup.next, setup.inputs, model, pending names and args])`. Setups that share behaviour references merge. So declare `next` at module scope unless they must close over a setup choice.
- **Live clicks.** A click inside a card sends the Message through `atlas.send`, which validates it with `Schema.is(program.Message)` and records an `Event` hop.
- **Budget.** `budget` (5,000) caps exploration. `reach().isComplete` is false when the budget is hit.
- **Cost.** Identity cost is proportional to the objects `update` replaced, each at its own width. A changed 10,000-element array is still rescanned. Do not claim O(change).

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

- View-driven cases use the public Scene driver to record Messages from enabled buttons and configured text inputs. This is a limited probe, not universal interaction introspection; Mount-backed views are unsupported. Other examples choose explicit Messages in `next`.
- The Weather view hard-codes `id="location"`, so several Weather cards trigger Foldkit's duplicate-id warning.
- A state's address is the trace by which it was first found. If a live click discovers a state before breadth-first search does, its address goes through an `Event` hop. It still resolves.
- Command definitions don't expose their declared `messages` or argument schemas. Answers are validated against the program Message schema, not a per-Command result schema. The modeled environment must describe realistic responses; unique Command names are required. Interrupts and subscriptions are not automatically modeled.

### Directions discussed

- **Invariants** over every reachable state. Built-in ones: dead buttons, dead ends, stuck spinners, double submit. They would report shortest counterexample traces, following the pattern in `src/lab/atlas.test.ts`.
- **Diffing the explored state set** between commits (the `*.atlas` snapshots are the start of this). The output would read like "3 new states, 1 removed, 2 changed render".
- **Grouping states by rendered accessibility tree**, with text-only screens for agents and screenshots only for groups that changed.
- **Pairwise coverage** across environment axes (viewport, locale, long strings) using a priority order.
- **Quint conformance**: replay Quint ITF traces through the UI. See `~/research-ideas.md`.
