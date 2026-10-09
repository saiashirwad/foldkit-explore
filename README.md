# Foldkit Explore

Explore reachable states of a Foldkit program, within declared possibilities and exploration limits.

You describe what can vary as named choices: the starting Model, what a user might do, and how each Command might be answered. The lab walks the program's real `update` through those choices and renders discovered states with the program's real `view`. A complete search covers the declared environment, not every possible browser or server behavior.

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

| Path                                             | What                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `src/lab/fixture.ts`                             | `fixture()` and `outcomes()`: named choices, enumerated by replay   |
| `src/lab/identity.ts`                            | Hash-consing for structural sharing between states                  |
| `src/lab/atlas.ts`                               | A program's memoized state graph: setups, moves, answers, addresses |
| `src/lab/lab.ts`                                 | The lab itself, a Foldkit program                                   |
| `src/main.cases.ts`, `src/release/main.cases.ts` | Cases for the two example programs                                  |

## View-driven exploration (Signup)

Signup's cases specify initial plans, a finite `Username` input domain, and
Command response fixtures. There is no second implementation of its navigation:
`src/lab/interactions.ts` uses the **public `foldkit/scene` API** to render a Model,
click enabled buttons (including form submit buttons), and type the configured
values into editable textboxes. A recording update captures the emitted Messages;
the atlas then applies the program's real update. It never executes Commands.

This is deliberately a limited environment, **not universal DOM exploration**.
Selects, checkboxes, links, keyboard/pointer gestures, subscriptions, and custom
control protocols are not automatically enumerated. A single interaction that emits
multiple Messages (for example click plus submit) is explicitly rejected rather
than represented as independent alternative moves. Mount-backed views are not
supported by the probe: Scene's unresolved-Mount assertions fail rather than
silently treating their behavior as covered. Existing Weather and Release cases
still use explicit moves. A setup must choose `inputs` or `moves`, not both.

Programs select `schedule: 'oldest' | 'any'` (default: oldest). Signup allows any
pending Command to finish. Response fixtures make independent choices each time;
there is no persistent simulated server or fairness/liveness assumption. Depth
and the state exploration threshold remain visible. The threshold stops subsequent
BFS layers; it is not a strict memory cap. “Complete” is relative to the declared
inputs, responses, and scheduler. Signup's unlimited pending checks still make its
exploration incomplete.

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
separate case reuses Signup's starts and responders but tries one long unbroken
username; it does not enlarge the ordinary Signup snapshot domain. Inspect the
Confirm screen's trace: `home → Username = long value → CheckUsername #1 free →
click Next → click Next`. Its address can replay the same execution in a fresh
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
