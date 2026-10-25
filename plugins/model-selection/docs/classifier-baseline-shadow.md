# Classifier baseline shadow (report-only)

Every live tier classification now carries a second opinion: a deterministic
rules baseline compiled from the RUBRIC anchors, recorded next to the
classifier's verdict. The baseline never decides anything — it is the held-out
comparison the entry-gate enforcement bar reads.

## The contract

**Entry (shadow):** both classify paths (`classifyIssues` and the creation pin)
run `baselineTierForIssue` over the same truncated title/description the
classifier saw. A decisive baseline marks the card as a *would-skip*: a call
the entry gate could have avoided.

**Exits (report-only):**

- *Abstain on veto.* Any T1-veto marker in the text abstains the baseline for
  that card — the rules stay out of trust-sensitive territory entirely.
- *Drift exit.* `classifierDrift` is true once the rolling window holds at
  least `driftMinN` outcomes and the classifier's T1 share reaches
  `driftT1Share` (defaults 50 / 0.85, above the measured 0.77 skew).

## Rules

| rule id | tier | anchor |
|---|---|---|
| `named-review` | T2 | named PR/commit/SHA review against written criteria |
| `presents-options` | T2 | presents options for someone else to choose |
| `tool-fix` | T2 | builds/fixes tooling against a stated failure |
| `roster-reconcile` | T2 | supplied-source data entry, fixed-method reruns |
| `track-only-parent` | T3 | coordinating card, work happens elsewhere |
| `mechanical` | T3 | formatting, renames, verbatim extraction, label hygiene, test registration |

The baseline never emits T1. Overlap resolves upward (T2 beats T3). Veto
markers: `credential`, `secret`, `permission`, `provision`, `production`,
`incident`, `approv`, `deploy`, `upstream`, `irreversib`, `access`.
`security` alone is not a veto. The RUBRIC text in
`src/engine/classify.ts` is the policy source; any anchor edit revisits
`src/engine/classify-baseline.ts` with it.

## Evidence surfaces

- Per-card activity metadata: `baseline`, `baselineRule`, `baselineAgrees`,
  `classifierDrift` (absent when `baselineMode: "off"`, nulls on abstention).
- Rolling window: `classifierShadow` state, newest 50
  `{t, b, a}` pairs (`shadowStats` counts `n` / `decisive` / `agreed` / `t1`).

## Enforcement bar (not this slice)

Skipping the classifier call on a decisive baseline ships only after, on live
shadow data: (a) agreement ≥ 95% over ≥ 50 decisive pairs, (b) human review of
every disagreement with a recorded verdict, (c) the drift flag clear for the
window. Rollback of this slice is `classification.baselineMode: "off"` (or a
revert); both leave every label and pin untouched.
