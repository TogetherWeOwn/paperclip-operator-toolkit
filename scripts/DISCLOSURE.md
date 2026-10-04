# Public disclosure checks

Run `bash scripts/disclosure-scan.sh plugins` from a repository checkout.
Explicit roots may include tracked files as well as directories. Run
`bash scripts/disclosure-scan.sh --no-git DIR` for one plain directory.

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

The CI change detector and draft handling follow the main branch's existing policy.
Full-suite verification of a draft is available through `workflow_dispatch` on its
branch without marking it ready. Record the tested head SHA; a later push invalidates
that evidence. Every plugin job runs on the standard hosted runner.
