# Public disclosure checks

Run `bash scripts/disclosure-scan.sh` from a repository checkout; it measures
the whole tracked tree, as CI does. Explicit roots may include tracked files as
well as directories. Run `bash scripts/disclosure-scan.sh --no-git DIR` for one
plain directory.

- Exit **0** means a nonempty inventory was read and no disclosure pattern matched.
- Exit **1** means disclosure findings; output names files and lines, not their contents.
- Exit **2** means usage error or incomplete measurement. Missing/unreadable roots,
  symlinks, empty coverage, failed Git enumeration, and failed reads are not clean.
- Lockfiles are scanned. Tracker detection is case-insensitive and also covers joined
  and embedded forms. A version label is not automatically an exemption.

`bash scripts/test_disclosure_scan.sh` proves the detectors can fail and incomplete
measurements refuse. `python3 scripts/test_plugin_ci_wiring.py` pins change gating,
the eight-shard sweep and aggregation into `ci-ok`. Neither self-test certifies the
published tree; the real tree scan and independent exact-head review remain gates.

The CI change detector preserves docs-only/draft savings, but dependencies,
lockfiles, `.github` and disclosure-boundary changes force the full suite even on
a draft. This permits review-before-readiness without bypassing review or checks.
A `workflow_dispatch` full-run trigger is also declared for explicit verification;
its availability depends on the workflow revision registered on GitHub. Record
the tested head SHA; a later push invalidates that evidence. Every plugin job runs
on the standard hosted runner.

## Full-history secret scan

Run `bash scripts/secret-scan.sh` with checksum-verified gitleaks 8.30.1 installed.
Shallow clones refuse. The first pass scans without ignores; it then materializes
native gitleaks exceptions for the exact reviewed historical fixture fingerprints
and rescans. Exceptions are keyed by commit, path, rule and line, not the line's
contents, a file path alone, or a whole commit. A changed finding receives a new
fingerprint and remains red. Inline allow comments are disabled in both passes.

`scripts/gitleaks-history-fixtures.json` contains SHA-256 hashes of eleven
independently inspected pre-existing synthetic/negative-test findings. Hashing
keeps obsolete fixture naming out of the public registry; it does not broaden
what is ignored. Never add a new hash merely to make CI green: inspect the exact
finding and obtain independent review first. No live secret exception is approved.

`GITLEAKS=/path/to/gitleaks python3 scripts/test_secret_scan.py` exercises exact
fingerprint matching and the real scanner. An unrelated synthetic canary still
fails when a fixture marker or an inline allow comment appears on the same line.
New findings fail; parse, Git and scanner errors are unmeasured, not clean.
