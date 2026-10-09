# Foldkit Explore

Explore reachable states of a Foldkit program, within declared possibilities and exploration limits.

You describe what can vary as named choices: the starting Model, what a user might do, and how each Command might be answered. The lab walks the program's real `update` through those choices and renders discovered states with the program's real `view`. A complete search covers the declared environment, not every possible browser or server behavior.

## Model one next step

A setup provides an initial Model, optional initial Commands, and a `next(state)`
generator. Each outcome of `next` describes **one transition**, not a whole
scenario. The atlas enumerates those transitions, applies the real `update`, and
repeats from every resulting state. It never executes Command effects.

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

  const request = yield* fixture(
    'pending',
    pendingRequests(state, FetchWeather),
  )
  if (request.command.args.zipCode === '') {
    return answer(
      request,
      Message.FailedFetchWeather({ error: 'Zip code required' }),
    )
  }
  const message = yield* fixture('result', {
    succeeded: Message.SucceededFetchWeather({ weather: weatherData }),
    failed: Message.FailedFetchWeather({ error: 'Location not found' }),
  })
  return answer(request, message)
}

export function* WeatherCases(): Choices<Setup<Model, Message>> {
  const zipCodeInput = yield* fixture('zip', { empty: '', valid: '90210' })
  return {
    model: { zipCodeInput, weather: WeatherAsyncData.Idle() },
    next,
  }
}
```

Import `NextState`, `Transition`, `Setup`, `send`, `answer`, and `pendingRequests`
from `src/lab/atlas.ts`; `Choices` and `fixture` come from `src/lab/fixture.ts`.
The complete example is in `src/main.cases.ts`.

- `fixture(name, alternatives)` is nondeterministic choice. Ordinary control flow
  decides which later choices exist; `yield*` composes reusable choice generators.
- An **empty fixture prunes a path**. With no pending request, the response branch
  has no outcome, but user actions still exist.
- An **early return produces a transition** without reaching later choices. Above,
  an empty ZIP never gets a success/failure choice.
- `send(message)` describes a user transition and leaves pending Commands alone.
- `pendingRequests(state, Definition)` offers every matching pending occurrence,
  keyed by its zero-based queue position, with the definition's typed arguments.
  Command definitions must have unique names within a program, as Foldkit matches
  them by name. Effects are not run and their argument schemas are not revalidated.
- `answer(request, message)` consumes exactly that selected occurrence and applies
  its Message through `update`. A foreign or invalid occurrence is rejected.
- Scheduling is ordinary code in `next`: offer all requests, or restrict the
  alternatives. There is no separate scheduler or responder registry.
- Omitting `next` makes a setup terminal. `next` must return a transition on every
  completed path; use an empty fixture for a path with no transition.

Generators must be deterministic and free of side effects: enumeration replays
**one next-step computation** for each choice path. It does not replay application
history. Keep `next` at module scope when setups share the same behavior; closures
with different identities deliberately keep execution states separate.

This explores both `submit → clear → answer` and `submit → answer → clear`, without
writing either scenario. Foldkit's `update` determines reachable Models; the
choices bound the modeled environment. Exclude events only when they cannot happen
or are deliberately out of scope. Use properties to report undesirable reachable
states, rather than pruning away the evidence. This is bounded exploration, not
TLA+/Quint temporal-logic checking or a liveness proof.

## Run it

```bash
bun install
bun dev            # then open /lab.html
bun run test       # checks behavior baselines at fixed depths in src/lab/*.atlas
```

In the lab you can:

- filter by choices in each state's first-discovery trace (not every possible path);
- go deeper one step at a time;
- click inside a card to drive it like the real app;
- answer a pending Command from the card;
- rewind through a state's trace in the inspector;
- pin a state to keep it.

## How it stays fast

- **States are values.** `update` is pure and Models are plain data, so exploring never replays history. Each state is stepped from directly.
- **Equal execution states merge.** Model, pending Commands, and setup behavior participate in identity (`src/lab/identity.ts`). Two paths to the same execution share a graph node; identifying a new state visits replaced objects at their own width.
- **Screens group separately.** Several executions can share a preview without losing their different pending work or future transitions.
- **Work is memoized.** Each state's successors are computed once. Each card's view re-renders only when its state changes (`createKeyedLazy`).
- **Addresses outlive sessions.** The lab's Model refers to states by the path of choices that reaches them, so a reload finds the same states again.

## Layout

| Path                                             | What                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `src/lab/fixture.ts`                             | `fixture()` and `outcomes()`: named choices, enumerated by replay     |
| `src/lab/identity.ts`                            | Hash-consing for structural sharing between states                    |
| `src/lab/atlas.ts`                               | A program's memoized state graph: setups, next transitions, addresses |
| `src/lab/lab.ts`                                 | The lab itself, a Foldkit program                                     |
| `src/main.cases.ts`, `src/release/main.cases.ts` | Weather and Release next-step models                                  |

## View-driven exploration (Signup)

Signup's cases specify initial plans, a finite `Username` input domain, and
a `next` generator that chooses user interactions or Command answers. There is no
second implementation of its navigation:
`src/lab/interactions.ts` uses the **public `foldkit/scene` API** to render a Model,
click enabled buttons (including form submit buttons), and type the configured
values into editable textboxes. A recording update captures the emitted Messages;
`state.interactions` exposes named Message alternatives to `next`; the atlas then applies the program's real update. It never executes Commands.

This is deliberately a limited environment, **not universal DOM exploration**.
Selects, checkboxes, links, keyboard/pointer gestures, subscriptions, and custom
control protocols are not automatically enumerated. A single interaction that emits
multiple Messages (for example click plus submit) is explicitly rejected rather
than represented as independent alternative moves. Mount-backed views are not
supported by the probe: Scene's unresolved-Mount assertions fail rather than
silently treating their behavior as covered. Existing Weather and Release cases
choose explicit Messages. An `inputs` domain makes view-derived interactions
available to `next`; it does not automatically add transitions. A generator can
combine those interactions with explicitly modeled events.

Signup's `next` allows any pending Command to finish. Result fixtures make
independent choices on every answer; there is no persistent simulated server or
fairness/liveness assumption. Depth and the state exploration threshold remain
visible. The threshold stops subsequent BFS layers; it is not a strict memory cap.
“Complete” is relative to the declared `next` choices and initial states. Signup's
unlimited pending checks still make its exploration incomplete.

Typed `Property<Model, Message>` predicates can check states and transitions.
Signup's predicates live in `src/signup/properties.ts`. `atlas.check(depth)` returns
one shortest explored counterexample per failing property, using breadth-first
paths rather than earlier live-click discovery paths. The inspector's Properties
section shows those traces as clickable steps. A passing bounded check is not a
proof about all executions. Checks always use breadth-first exploration, independently
of the selected gallery search. “No violations found” describes that bounded check.

The `.atlas` snapshots record Models, pending Commands, and transitions. They are
**behavior baselines, not appearance baselines**: CSS or view-only regressions can
leave them unchanged.

The gallery groups **equal rendered markup** for view-driven cases (text,
attributes, properties, classes, styles, and children), not screenshots or computed
accessibility trees. Other programs use an explicitly labeled equal-Model fallback.
Grouping never changes graph identity: pending queues and environment references
remain significant. Choose a group's execution state in the inspector; card actions
apply to that selected state. Filters still use each state's first discovery trace.

## A reproducible visual stress case

Select **Signup · long content**, keep BFS, and increase depth to **4**. This
separate case reuses Signup's starts and `next` generator but tries one long unbroken
username; it does not enlarge the ordinary Signup snapshot domain. Inspect the
Confirm screen's trace: `home → user input → check/free → user Next → user Next`. Its address can replay the same execution in a fresh
atlas, including pending work.

This case exposed real summary overflow in a 360px browser viewport. The username
now wraps instead of extending beyond the summary. See [the bounded browser
comparison](docs/visual-inspection.md) for evidence and limits. A scaled gallery
card is not a device viewport, and passing properties do not establish visual
correctness.

The Scene adapter brings testing-driver code into the lab bundle. A production lab
build was about 390 kB / 126 kB gzip during implementation; this is the total lab
bundle, not a measured incremental cost. The usual `bun run build` builds only the
plain weather entry, so validating the lab requires building `lab.html` explicitly.
