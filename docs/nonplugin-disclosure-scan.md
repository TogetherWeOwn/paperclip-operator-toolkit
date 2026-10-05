# Manifest-scoped non-plugin disclosure scan

The always-on disclosure job retains the existing plugin scan and also measures
an explicit set of generic non-plugin ports, dependencies, fixtures and scan
metadata. Its literal file list is `scripts/nonplugin-disclosure-files.txt`.
The full-history secret scan remains a separate always-on job.

This is an additional coverage boundary, not an exclusion list for either
existing scan. It does **not** certify the entire repository, inherited legacy
files, workflow history or same-meaning disclosure safety. Workflow changes and
material outside the manifest still require separate diff/classification review.
No scanner result grants publication, security-review or deployment approval.

## Run

From a tracked toolkit checkout on Linux with Python 3, Bash and `/usr/bin/git`:

```sh
python3 scripts/test_nonplugin_disclosure_scan.py
python3 scripts/nonplugin-disclosure-scan.py --manifest scripts/nonplugin-disclosure-files.txt
```

Or supply the repository root and manifest path explicitly. The wrapper needs no
package installation, network, credential or live service. It uses credential-free
local Git only to verify regular stage-zero index membership. New untracked
work-in-progress files refuse rather than pretending to have CI coverage.

Every nonempty manifest line is one canonical repository-relative file path.
Comments, globs, exclusions, duplicates, blank lines, malformed encodings, dot
traversal, absolute paths and ambiguous spellings are not accepted. The wrapper
also refuses missing/untracked/unmerged/nonregular, symlink or unreadable files
and path ancestors. It snapshots validated bytes and modes privately before
invoking the preserved scanner, without modifying the repository or index.

| Exit | Meaning |
| --- | --- |
| 0 | The explicit nonempty manifest snapshot was completely measured and the detector found no patterns. |
| 1 | The detector found disclosure patterns within that snapshot. |
| 2 | Coverage or execution was incomplete; this is not a clean scan. |

Missing or wrong successful measurement counts cannot read green. Changes during
an individual file snapshot refuse. This is not an atomic commit-bound snapshot,
proof that working-tree bytes match HEAD, or proof that manifest selection is
complete. The existing scanner's detector limitations still apply.

## Maintain coverage

When adding or extracting generic tooling, include every public source,
dependency, fixture and test in the sorted manifest. Review that selection with
the change; do not omit a file to silence a finding. Preserve the independent
plugin and full-history secret scans. The CI-wiring controls require the scan
self-test before measurement and full coverage of the newly ported capture and
protection-rule modules, including their local harness dependencies.

Retired runtime assets, deployment inputs and operator-owned authority are not
made public or runnable by a manifest. Synthetic fixtures establish behavior,
not live authority. Existing disclosure debt outside this manifest needs its own
review and disposition, not a claim that this scoped green made it disappear.
