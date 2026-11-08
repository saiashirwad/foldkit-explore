# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: false

## Project Notes

### What this is

Foldkit Explore shows the states a Foldkit program can reach. It began as Branch Lab, a React prototype where a generator yielded named choices (`fixture()`) and a replay rendered every combination. Here the same choice language drives a real Elm-style program: `update` is pure and Models are plain data, so the explorer steps states directly and explores _time_ (moves and Command answers) as well as setup.

The person driving this reads every line. Keep changes small and easy to review. Ask before changing a direction that has already been settled. The generator form for choices is settled; keep it.

### Run

```sh
bun dev            # open /lab.html (index.html is the plain weather app)
bun run test       # vitest
bun run typecheck
bun run lint       # oxlint with the Foldkit plugin; its rules are strict and right
bunx oxfmt src     # format
```

### Shape

See `README.md`. `src/explore/` is the library: `fixture` and `outcomes`, `explore`, and the gallery. Everything else is example programs.

- Exploration is breadth first. States merge on a stable key of input, Model and pending Commands, or on `Environment.key`.
- Choices are replayed from the start for each path, so they must be pure.
- Commands never execute. `answer` consumes one occurrence, then runs the real `update`.
- `Environment.next` offers moves explicitly. Nothing is derived from the view.
- The gallery computes the graph in its view, memoized by `createLazy`. The `states` cap keeps that cheap. Move it to a Command if the cap rises.

### Conventions

- **No type assertions.** Lint forbids `as`. `fixture` finds its value among its own cases. `pendingRequests` uses a name-based type predicate, relying on unique Command names within a program.
- **`Got*` naming** is reserved for typed Submodels.
- **Lazy views.** `createLazy` view functions live at module scope and take primitives or stable references.
- **Styling.** Lab CSS sits in `@layer components` and never styles inside `.state-preview`.
- **Effect v4:** `Hash.combine` is curried only; `Predicate.isObject` excludes arrays; `Array.filterMap` takes a `Result`, so use `Array.getSomes` for Options.

### Known issues

- Previews are inert: clicking inside a state does nothing.
- The Weather view hard-codes `id="location"`, so several Weather cards trigger Foldkit's duplicate-id warning.
- Command definitions don't expose their declared `messages` or argument schemas, so an answer is not checked against its Command.
- Interrupts and subscriptions are not modeled.

### Directions

- Add Foldkit's Block API once it is stable. The core needs only `start`, `update` and `view`, so an adapter should be thin.
- Export a UI prune as a code rule.
- Temporal properties: dead ends, stuck spinners.
- Version comparison under one environment (removed in the simplification; see git history).
