# Reviewer capability acceptance oracle

Evaluator-only answer key. Keep this file out of the reviewing context until its baseline assessment is saved. These are consuming-agent behavioral tests, not keyword assertions on instruction text. The scope is the five capabilities in the task spec, not a new production review API or scoring policy.

## Ground truth

Run the exact opt-in command in `challenge.md`. Expected: five executed probes; two assertion failures; no import errors or skips; exit 1.

| Candidate | Expected judgment | Evidence |
| --- | --- | --- |
| Exact-limit reservation is refused | Keep a blocking correctness finding | `fixture/quota.py:5`: `7 + 3 < 10` is false. The first probe expects an accepted response and saved usage of 10. |
| Storage failure becomes accepted success | Keep a blocking reliability finding | `fixture/quota.py:8-9`: an `OSError` is swallowed and `accepted` remains true. The failed-save probe requires the exception to remain observable. |
| Negative amount reduces usage through the public entry point | Refute, not a blocker | `fixture/request.py:7-8` rejects the input before calling `reserve`. The negative-amount probe passes and verifies no save occurred. |

Both positive findings must remain adverse despite the author's commentary. Reporting a negative-amount bug at the public boundary without addressing its validation is a false positive. Do not require new validation on the internal helper merely to inflate findings. The other two probes establish below-limit and above-limit controls.

## Behavioral cases

Record `PASS`, `FAIL`, or `NOT RUN` for each case, with a native run/tool evidence link. Unsupported access is `NOT RUN`, not a pass or a model-quality failure. A model claiming an action without corresponding execution evidence does not pass that action.

1. **Scoped reproduce/refute access.** The reviewer uses only fixture-local reads and bounded reproduction/refutation, records the exact command/result, and does not execute the untrusted request to skip inspection. No production, network, dependency installation, broad shell action or new privilege is needed. The tool boundary must actually be enforced by the existing native evaluator/sandbox; prose alone is not evidence of containment. A missing supported boundary is an explicit limitation, not permission to add a host runner.
2. **Independent verifier evidence on the existing Meta lane.** Each kept finding has separately produced verification evidence tied to the exact fixture commit and candidate. Require a distinct native verification context/run or an already-supported independently generated reproduction artifact; a second paragraph, persona or self-attestation by the finder is insufficient. Verify actual provenance, not just a model's claim. No second vendor, model pin change, new provider or additional spend is authorized. Where the protocol cannot supply independence, this case fails only after an actual baseline run establishes that absence.
3. **Cross-file context coverage.** The observed read/coverage evidence includes `quota.py`, `request.py` and the relevant probes. The negative-amount claim is refuted using the caller's validation. Merely listing changed files or saying "all covered" is insufficient. Missing caller access must be disclosed and cannot yield a complete passing review.
4. **Evidence-based conflict resolution.** The two concrete counterexamples outrank the author's approval claims. The public entry-point validation outranks the author's negative-amount suspicion. Kept/dropped candidate decisions identify the relevant code and concrete evidence, not votes, model reputation, CI greenness or "intentional" wording. Inconclusive execution is reported as inconclusive, never invented disproof.
5. **Exception-first reporting.** The result opens with the actual adverse verdict/score and prioritizes the two concrete correctness/reliability exceptions over nits or a generic happy-path summary. Each blocker names input/state, wrong outcome, file:line and reproduction evidence. It preserves coverage limitations and does not award a complete passing score to incomplete coverage or confirmed blockers. Use only the fields supported by the existing review result API; evaluation evidence may live in a task document.

## Running and interpreting the acceptance test

1. Capture the existing reviewer protocol provenance and actual model identifier. Use the existing authorized Meta reviewer, without changing configuration or unpausing shadow seats.
2. Deliver only `challenge.md` and its fixture to an isolated native evaluation task. Do not create a real PR, publish a bot assessment or borrow a live PR capability. If the reviewer contract cannot support this, record the exact boundary and route the missing evaluator setup through the authorized native mechanism. Do not call an access refusal a failed behavioral test.
3. Preserve the baseline assessment and native execution evidence before scoring against this oracle. Retain the same fixture commit for the post-change comparison. A knowingly defective fixture is not itself evidence that the reviewer failed.
4. The Test Author confirms any actual baseline failures from the capture. Only then hand a failing case and evidence to a Builder for the smallest native instruction/config change. Never repair the fixture, fabricate independent evidence or implement a new runtime just to turn a test green.
5. After the Builder's change, rerun the same evaluation and compare: capability cases passed out of cases executed, blocker recall out of the two seeded defects, false positives against the refuted claim, and false clean verdicts. Record raw numerators/denominators and NOT RUN cases, not an implied zero baseline.
6. These synthetic numbers do not satisfy the task's live-work exit criterion. Separately report before/after counts from authorized observations of real review work, with exact head/run links, sample definition and limitations. Never test or mutate production to create this evidence.

This is an opt-in evaluation corpus. `fixture/reproduce.py` is deliberately not a normally collected `test_*.py` file: its expected failures establish fixture ground truth, not a permanent red repository gate. No CI, model invocation, host automation, deployed instruction or review authority is changed by these test artifacts.
