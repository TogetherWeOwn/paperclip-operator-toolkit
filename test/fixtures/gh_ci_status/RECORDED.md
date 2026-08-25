# Recorded Checks API responses (TOG-381)

These are **verbatim** responses from the live GitHub Checks API for
`TogetherWeOwn/paperclip-ops-tooling`, recorded on **2026-08-25**. Nothing here
was written by hand.

That matters more than it sounds. The bug TOG-381 fixes is that a job GitHub
*never ran* is reported as `status: completed, conclusion: failure` — byte-for-byte
the shape of a job that ran and genuinely failed. A hand-authored fixture for
that case would only prove the reader agrees with whoever typed the fixture. The
whole question is whether it agrees with **GitHub**, so the answer has to come
from GitHub.

## Provenance

| file | source | what it is |
|---|---|---|
| `check-runs-4f2bea9-nonstart.json` | `GET /repos/{o}/{r}/commits/4f2bea9/check-runs` | The 2026-08-25 outage. 4x `completed/failure`, **2–3s** each. No job ran. |
| `check-runs-ae85924-nonstart-14s.json` | …`/commits/ae85924/check-runs` | Same outage, but one non-start took **14 seconds**. The witness against any duration-only rule. |
| `check-runs-24f0d30-green.json` | …`/commits/24f0d30/check-runs` | Post-recovery green. 4x `success`, 317 / 51 / 15 / 12s. |
| `check-runs-4fd26c0-realred.json` | …`/commits/4fd26c0/check-runs` | A genuine red build. 2x `failure` at 39s and 41s, alongside 4 successes. |
| `annotations-976527433{90,32,25,00}-nonstart.json` | `GET /repos/{o}/{r}/check-runs/{id}/annotations` | The four `4f2bea9` runs. Each carries the billing text at `annotation_level: failure`. |
| `annotations-97651116158-nonstart-14s.json`, `annotations-976511161{83,02,17}-nonstart-14s-batch.json` | …`/check-runs/{id}/annotations` | The four `ae85924` runs, including the 14s one. |
| `annotations-973258{26859,18136}-realred.json` | …`/check-runs/{id}/annotations` | The genuine red's annotations: `"Process completed with exit code 1."` at `failure` level. |
| `annotations-97653688773-green-warning.json` | …`/check-runs/{id}/annotations` | A **successful** run's annotations — a Node 20 deprecation notice at `warning` level. |

## The two facts these fixtures exist to pin

1. **`conclusion` cannot separate the cases.** `4f2bea9` and `4fd26c0` are both
   "completed/failure" in every field the reader inspected before TOG-381.

2. **"Has annotations" cannot separate them either.** `annotations-97653688773`
   is from a run that *passed*, and it is not empty. Only the *failure*-level
   annotation carrying `"The job was not started because…"` licenses the
   `non-started` verdict, and `test_gh_ci_status.sh` asserts the level check
   separately from the text check so neither can quietly stop mattering.

Duration is a prefilter for the extra API call and nothing more. The recorded
ranges overlap — a 14s non-start above, and our own `bash -n` scan can fail
legitimately in about 2s — so no threshold separates them even in principle.

## Permissions

Every call above was made with a broker mint holding `checks:read` and **not**
`actions:read` (which 403s for our App — see TOG-380 and TOG-247). The
annotations endpoint was measured 200 under that scope, which is why the
classification does not need a wider token than the one that already read the
failure it is classifying.

## Re-recording

```sh
R=TogetherWeOwn/paperclip-ops-tooling
F=test/fixtures/gh_ci_status
# Mint into a 0600 header file — never put the token in argv (TOG-200).
node gh-app-token.js credential get <<< $'protocol=https\nhost=github.com\n' \
  | sed -n 's/^password=//p' > "$TMPDIR/tok" && chmod 600 "$TMPDIR/tok"
printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n' \
  "$(cat "$TMPDIR/tok")" > "$TMPDIR/hdrs" && chmod 600 "$TMPDIR/hdrs"

curl -sS -H "@$TMPDIR/hdrs" \
  "https://api.github.com/repos/$R/commits/4f2bea9/check-runs?per_page=100" \
  | jq -S . > "$F/check-runs-4f2bea9-nonstart.json"
curl -sS -H "@$TMPDIR/hdrs" \
  "https://api.github.com/repos/$R/check-runs/97652743390/annotations?per_page=100" \
  | jq -S . > "$F/annotations-97652743390-nonstart.json"
# …and so on per the table above. `jq -S` only sorts keys; no field is altered.
```

GitHub retains check runs and their annotations well past the commits'
usefulness, but not forever. If a re-record ever comes back `404`, do **not**
substitute a hand-written body — the fixture's value is entirely in its
provenance. Record the equivalent shapes off a newer incident and update this
table instead.
