# Long-content inspection

This is one browser experiment, not a screenshot regression suite or an exhaustive
visual review.

## Reproduce in the lab

Run `bun dev`, open `/lab.html`, select **Signup · long content**, and use BFS at
depth **4**. Find the Confirm preview with the Free plan and inspect its trace:

1. `home`
2. `Username = "averylongunbrokenusernameforcheckinghowaccountdetailswraponnarrowdisplays"`
3. `CheckUsername #1 free`
4. `click Next`
5. `click Next`

This state has no pending Commands. Account with the same available name is the
prefix ending at step 3. The focused exploration test finds Confirm through moves
and answers, then resolves its address in a fresh atlas and compares Model and
pending Commands. No success Model is hand-authored.

## Observed result

Chromium **153.0.8010.12** rendered those executions in the actual gallery at
1440×1000 and 360×800 CSS pixels, and in a temporary isolated renderer at
360×800. The isolated renderer loaded application styles only and resolved the
same discovered address; neither renderer executed real Commands. The gallery's
selected state IDs were checked against the isolated specimens.

| Observation                                    | Before                                    | After                                                |
| ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Isolated Confirm document width / scroll width | 360 / 696px                               | 360 / 360px                                          |
| Confirm username                               | Extended outside summary in both contexts | Fully wraps in both contexts                         |
| Isolated Account                               | Input contained its long value            | Unchanged; document width / scroll width 360 / 360px |
| Isolated Confirm navigation                    | Not asserted in initial capture           | Back → Next returns to Create account                |

Screenshots were rendered and inspected. The repair is local to the summary's
username: permit the grid item to shrink and wrap the unbroken text. Gallery
chrome and exploration identity were not changed. The gallery uses scaled cards,
so its text wrapping is not pixel-identical to an isolated device viewport.

Local artifacts are in `/tmp/foldkit-inspection`: `before-report.json`,
`after-report.json`, `before-*.png`, `after-*.png`, and the temporary automation and
renderer sources. These are temporary evidence, not committed baselines. The
renderer was removed from the application after the comparison.

## Limits

This covers Account and Confirm, one long value, one browser, and one isolated
viewport. It does not establish focus, accessibility, animation, other browser,
or all later-step correctness. It also does not prove gallery rendering generally
matches isolated rendering. Behavioral `.atlas` baselines cannot detect this CSS
regression; repeat browser inspection when changing presentation.
