#!/usr/bin/env python3
"""Bounded, offline consistency diagnostics. Never grants disclosure acceptance.

Snapshots are untrusted claims: this checks their schema and internal bindings,
not Git objects, authenticated review records, scan bytes or delivery receipts.
The audit must keep its exact-pin verdict regardless of this result.

There are no built-in repository, tracker or approver mappings. An operator-owned
policy, separate from the untrusted evidence, must explicitly bind the diagnostic
class. The CLI reads --policy or DISCLOSURE_AUDIT_PROVENANCE_POLICY; unset,
unreadable or malformed policy refuses evaluation. Its exact version-1 keys are:
version, repository, recordNamespace, cardPrefix, releaseRefs, releasePrefixes.
Record pointers have the shape /NAMESPACE/issues/PREFIX-N, optionally followed by
#comment-ID or #document-KEY. Ref lists contain full refs/heads/ names; prefixes
end in /. Policy and real evidence remain local operator data, not bundled data.
Neither policy nor synthetic test records establish any authenticated approval.
"""
import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
import re
import stat
import sys
import uuid

MAX_BYTES = 2 * 1024 * 1024
MAX_RECORDS = 64
MAX_TRANSITIONS = 128
MAX_PUBLICATIONS = 512
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
REF = re.compile(r"refs/heads/[A-Za-z0-9._/-]+\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\Z")
NAMESPACE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
CARD_PREFIX = re.compile(r"[A-Za-z][A-Za-z0-9]{0,31}\Z")


class CannotEvaluate(ValueError):
    pass


@dataclass(frozen=True)
class Policy:
    repository: str
    record_pattern: re.Pattern
    release_refs: tuple
    release_prefixes: tuple


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names.split()):
        raise CannotEvaluate("malformed-evidence")
    return value


def text(value, pattern):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise CannotEvaluate("malformed-evidence")


def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise CannotEvaluate("malformed-time")
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise CannotEvaluate("malformed-time") from exc


def actor(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except ValueError as exc:
        raise CannotEvaluate("unbound-private-actor") from exc


def array(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise CannotEvaluate("malformed-or-oversized-evidence")
    return value


def enum(value, choices):
    if value not in choices:
        raise CannotEvaluate("malformed-evidence")


def parse_policy(data):
    fields(data, "version repository recordNamespace cardPrefix releaseRefs releasePrefixes")
    if type(data["version"]) is not int or data["version"] != 1:
        raise CannotEvaluate("unsupported-policy-schema")
    text(data["repository"], REPOSITORY)
    if len(data["repository"]) > 200:
        raise CannotEvaluate("malformed-provenance-policy")
    text(data["recordNamespace"], NAMESPACE)
    text(data["cardPrefix"], CARD_PREFIX)
    refs = array(data["releaseRefs"], 16)
    prefixes = array(data["releasePrefixes"], 16)
    if not refs and not prefixes:
        raise CannotEvaluate("empty-provenance-policy")
    for ref in refs + prefixes:
        text(ref, REF)
        if ref == "refs/heads/" or ref.startswith("refs/heads/cut/"):
            raise CannotEvaluate("malformed-provenance-policy")
    if any(ref.endswith("/") for ref in refs) or any(not prefix.endswith("/") for prefix in prefixes):
        raise CannotEvaluate("malformed-provenance-policy")
    if len(set(refs)) != len(refs) or len(set(prefixes)) != len(prefixes):
        raise CannotEvaluate("ambiguous-provenance-policy")
    pattern = re.compile(r"/" + re.escape(data["recordNamespace"]) + r"/issues/"
                         + re.escape(data["cardPrefix"])
                         + r"-[0-9]+(?:#(?:comment|document)-[A-Za-z0-9._-]+)?\Z")
    return Policy(data["repository"], pattern, tuple(refs), tuple(prefixes))


def require_policy(policy):
    if not isinstance(policy, Policy):
        raise CannotEvaluate("missing-provenance-policy")
    return policy


def review(value, policy):
    fields(value, "agentId headSha baseSha mergeSha verdict observedAt record superseded")
    actor(value["agentId"])
    for key in ("headSha", "baseSha", "mergeSha"):
        text(value[key], SHA)
    enum(value["verdict"], ("APPROVE", "CHANGES", "DEFER", "MISSING"))
    timestamp(value["observedAt"])
    text(value["record"], policy.record_pattern)
    if type(value["superseded"]) is not bool:
        raise CannotEvaluate("malformed-evidence")


def validate_record(r, policy):
    policy = require_policy(policy)
    fields(r, "repository ref tipSha capturedAt checkpoint history transitions")
    if not isinstance(r["repository"], str) or len(r["repository"]) > 200:
        raise CannotEvaluate("malformed-evidence")
    text(r["ref"], REF)
    text(r["tipSha"], SHA)
    timestamp(r["capturedAt"])
    c = fields(r["checkpoint"], "sha timingClass decisionAt agentId record firstPublicAt")
    text(c["sha"], SHA)
    enum(c["timingClass"], ("DECLARED", "POSTHOC"))
    timestamp(c["decisionAt"])
    actor(c["agentId"])
    text(c["record"], policy.record_pattern)
    if c["firstPublicAt"] != "unknown":
        timestamp(c["firstPublicAt"])
    h = fields(r["history"], "state checkpointSha tipSha commits")
    enum(h["state"], ("complete", "unavailable", "truncated"))
    text(h["checkpointSha"], SHA)
    text(h["tipSha"], SHA)
    for commit in array(h["commits"], MAX_TRANSITIONS):
        fields(commit, "sha parents")
        text(commit["sha"], SHA)
        for parent in array(commit["parents"], 8):
            text(parent, SHA)
    publication_count = 0
    for t in array(r["transitions"], MAX_TRANSITIONS):
        fields(t, "kind destinationRef pr mergeSha mergeParents publications authorScan codeReview disclosureReview integrationReview weakness holds findings")
        enum(t["kind"], ("squash", "pr-head", "direct", "rewrite", "cherry-pick"))
        text(t["destinationRef"], REF)
        text(t["mergeSha"], SHA)
        for parent in array(t["mergeParents"], 8):
            text(parent, SHA)
        p = t["pr"]
        if p is not None:
            fields(p, "number headRepo headRef headSha baseRepo baseRef baseSha authorAgentId mergedAt")
            if type(p["number"]) is not int or p["number"] <= 0:
                raise CannotEvaluate("malformed-evidence")
            for key in ("headRepo", "baseRepo"):
                if not isinstance(p[key], str) or len(p[key]) > 200:
                    raise CannotEvaluate("malformed-evidence")
            for key in ("headRef", "baseRef"):
                text(p[key], REF)
            for key in ("headSha", "baseSha"):
                text(p[key], SHA)
            actor(p["authorAgentId"])
            if p["mergedAt"] != "unknown":
                timestamp(p["mergedAt"])
        for pub in array(t["publications"], MAX_PUBLICATIONS):
            fields(pub, "sha addedLinesDigest messageDigest firstPublicAt")
            text(pub["sha"], SHA)
            text(pub["addedLinesDigest"], DIGEST)
            text(pub["messageDigest"], DIGEST)
            if pub["firstPublicAt"] != "unknown":
                timestamp(pub["firstPublicAt"])
            publication_count += 1
        s = fields(t["authorScan"], "agentId observedAt record publications")
        actor(s["agentId"])
        timestamp(s["observedAt"])
        text(s["record"], policy.record_pattern)
        for pub in array(s["publications"], MAX_PUBLICATIONS):
            fields(pub, "sha addedLinesDigest messageDigest")
            text(pub["sha"], SHA)
            text(pub["addedLinesDigest"], DIGEST)
            text(pub["messageDigest"], DIGEST)
        for key in ("codeReview", "disclosureReview", "integrationReview"):
            if t[key] is not None:
                review(t[key], policy)
        w = fields(t["weakness"], "applicable agentId observedAt record alternative")
        enum(w["applicable"], ("yes", "no", "unknown"))
        actor(w["agentId"])
        timestamp(w["observedAt"])
        text(w["record"], policy.record_pattern)
        if w["alternative"] is not None:
            a = w["alternative"]
            if not isinstance(a, dict):
                raise CannotEvaluate("malformed-evidence")
            enum(a.get("kind"), ("private-notification", "private-build"))
            extra = "recipient channel deliveryRecord" if a["kind"] == "private-notification" else "sourceRepo sourceSha"
            fields(a, "kind candidateSha sourceVisibility observedAt record verified " + extra)
            text(a["candidateSha"], SHA)
            enum(a["sourceVisibility"], ("private", "public", "unknown"))
            timestamp(a["observedAt"])
            text(a["record"], policy.record_pattern)
            if type(a["verified"]) is not bool:
                raise CannotEvaluate("malformed-evidence")
            if a["kind"] == "private-notification":
                # Private record pointers, never advisory text or addresses.
                text(a["recipient"], policy.record_pattern)
                text(a["deliveryRecord"], policy.record_pattern)
                enum(a["channel"], ("private-security-contact", "private-advisory"))
            else:
                if not isinstance(a["sourceRepo"], str) or not a["sourceRepo"] or len(a["sourceRepo"]) > 200:
                    raise CannotEvaluate("malformed-evidence")
                text(a["sourceSha"], SHA)
        for hold in array(t["holds"], 32):
            text(hold, policy.record_pattern)
        for finding in array(t["findings"], 128):
            fields(finding, "sha surface code")
            text(finding["sha"], SHA)
            enum(finding["surface"], ("added-lines", "message"))
            enum(finding["code"], ("operational-disclosure", "private-url", "credential", "unreviewed"))
    if publication_count > MAX_PUBLICATIONS:
        raise CannotEvaluate("oversized-evidence")


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CannotEvaluate("duplicate-json-key")
        result[key] = value
    return result


def load_json(path):
    try:
        # A bounded byte read alone can still hang on a FIFO/device. Validate
        # the opened descriptor, not a racy path precheck, before reading.
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise CannotEvaluate("nonregular-evidence")
            raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise CannotEvaluate("oversized-evidence")
        return json.loads(raw, object_pairs_hook=no_duplicates)
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise CannotEvaluate("unreadable-or-malformed-evidence") from exc


def load_policy(path):
    if not path:
        raise CannotEvaluate("missing-provenance-policy")
    return parse_policy(load_json(path))


def load(path, policy):
    policy = require_policy(policy)
    data = load_json(path)
    fields(data, "version records")
    if type(data["version"]) is not int or data["version"] != 1:
        raise CannotEvaluate("unsupported-schema")
    seen = set()
    for r in array(data["records"], MAX_RECORDS):
        validate_record(r, policy)
        key = (r["repository"], r["ref"])
        if key in seen:
            raise CannotEvaluate("ambiguous-ref-record")
        seen.add(key)
    return data["records"]


def release_ref(ref, policy):
    return ref in policy.release_refs or ref.startswith(policy.release_prefixes)


def result(status, codes, timing=None):
    return {"mode": "diagnostic-only", "acceptanceEnabled": False,
            "status": status, "codes": sorted(set(codes)), "candidateTimingClass": timing}


def evaluate(records, repository, ref, tip, pin, now, policy):
    """pin and policy are audit-owned input, never snapshot-owned rulings."""
    policy = require_policy(policy)
    r = next((r for r in records if r["repository"] == repository and r["ref"] == ref), None)
    if r is None:
        return result("finding", ["missing-ref-evidence"])
    if repository != policy.repository or ref.startswith("refs/heads/cut/"):
        return result("finding", ["out-of-class-exact-pin-only"])
    if r["tipSha"] != tip:
        return result("finding", ["moved-head"])
    captured = timestamp(r["capturedAt"])
    if not captured <= now <= captured + timedelta(hours=24):
        return result("cannot-evaluate", ["stale-or-future-evidence"])
    c, h = r["checkpoint"], r["history"]
    # Pin tuple includes the original adjudication time and record identity.
    if not pin or (pin["sha"], pin["timingClass"], pin["decisionAt"], pin["card"]) != (
            c["sha"], c["timingClass"], c["decisionAt"], c["record"].split("#")[0].rsplit("/", 1)[-1]):
        return result("finding", ["unaccepted-or-moved-checkpoint"])
    if c["firstPublicAt"] != pin["firstPublicAt"]:
        return result("finding", ["checkpoint-timing-relabelled"])
    if h["state"] != "complete":
        return result("cannot-evaluate", ["unavailable-or-truncated-history"])
    if h["checkpointSha"] != c["sha"] or h["tipSha"] != tip:
        return result("finding", ["history-bound-to-other-range"])
    commits, transitions = h["commits"], r["transitions"]
    if not commits or len(commits) != len(transitions) or commits[-1]["sha"] != tip:
        return result("cannot-evaluate", ["incomplete-transition-coverage"])
    if len({commit["sha"] for commit in commits}) != len(commits):
        return result("cannot-evaluate", ["ambiguous-history"])
    codes, timing, previous = [], c["timingClass"], c["sha"]
    if timestamp(c["decisionAt"]) > captured:
        codes.append("future-checkpoint-decision")
    for commit, t in zip(commits, transitions):
        p, s = t["pr"], t["authorScan"]
        if p is None:
            codes.append("missing-pr-provenance-exact-pin-only")
            previous = commit["sha"]
            continue
        if commit["parents"] != [previous]:
            codes.append("nonlinear-or-rewritten-history-exact-pin-only")
        if (t["mergeSha"], t["mergeParents"]) != (commit["sha"], commit["parents"]):
            codes.append("merge-object-binding")
        if t["kind"] not in ("squash", "pr-head"):
            codes.append("unsupported-transition-exact-pin-only")
        if p["headRepo"] != policy.repository or p["baseRepo"] != policy.repository or not release_ref(p["baseRef"], policy):
            codes.append("wrong-repo-or-pr-target")
        if t["destinationRef"] != ref:
            codes.append("wrong-destination-ref")
        if release_ref(ref, policy):
            if p["baseRef"] != ref or t["kind"] != "squash":
                codes.append("wrong-release-integration")
        elif p["headRef"] != ref or t["kind"] != "pr-head" or t["mergeSha"] != p["headSha"]:
            codes.append("renamed-or-unbound-pr-head")
        if t["kind"] == "squash" and (p["mergedAt"] == "unknown" or timestamp(p["mergedAt"]) > captured):
            codes.append("unverified-merge-time")
        pubs = t["publications"]
        scope = [{key: pub[key] for key in ("sha", "addedLinesDigest", "messageDigest")} for pub in pubs]
        if (not pubs or len({pub["sha"] for pub in pubs}) != len(pubs)
                or not {p["headSha"], t["mergeSha"]}.issubset({pub["sha"] for pub in pubs})
                or s["publications"] != scope):
            codes.append("incomplete-added-lines-or-message-scan")
        if s["agentId"] != p["authorAgentId"]:
            codes.append("unbound-author-scan")
        scan_at = timestamp(s["observedAt"])
        if scan_at > captured:
            codes.append("future-scan")
        closure_times = [scan_at]
        for key in ("codeReview", "disclosureReview", "integrationReview"):
            v = t[key]
            required = key != "integrationReview" or p["baseSha"] != previous
            if v is None:
                if required:
                    codes.append("missing-" + key)
                continue
            if v["verdict"] != "APPROVE" or v["superseded"]:
                codes.append("adverse-or-superseded-" + key)
            if v["agentId"] == p["authorAgentId"]:
                codes.append("nonindependent-" + key)
            if (v["headSha"], v["baseSha"], v["mergeSha"]) != (p["headSha"], p["baseSha"], t["mergeSha"]):
                codes.append("wrong-tuple-" + key)
            observed = timestamp(v["observedAt"])
            if observed > captured or (key != "codeReview" and observed < scan_at):
                codes.append("invalid-review-time")
            closure_times.append(observed)
        if t["holds"]:
            codes.append("publication-hold")
        if t["findings"]:
            codes.append("range-disclosure-finding")
        w = t["weakness"]
        if w["agentId"] == p["authorAgentId"] or timestamp(w["observedAt"]) > captured:
            codes.append("unbound-applicability-decision")
        if w["applicable"] == "unknown":
            codes.append("unknown-weakness-applicability")
        if w["applicable"] == "yes":
            a = w["alternative"]
            if (a is None or not a["verified"] or a["sourceVisibility"] != "private"
                    or a["candidateSha"] != p["headSha"] or timestamp(a["observedAt"]) > captured):
                codes.append("missing-or-unbound-private-alternative")
            else:
                if a["kind"] == "private-build" and (a["sourceSha"] != p["headSha"] or a["sourceRepo"] == policy.repository):
                    codes.append("private-build-not-exact-private-source")
                closure_times.append(timestamp(a["observedAt"]))
        closure_times.append(timestamp(w["observedAt"]))
        for pub in pubs:
            first = pub["firstPublicAt"]
            if first == "unknown" or timestamp(first) <= max(closure_times):
                timing = "POSTHOC"
            elif timestamp(first) > captured:
                codes.append("future-publication-time")
        previous = commit["sha"]
    return result("finding" if codes else "consistent-snapshot", codes, timing)


def read_pin(raw, repository, ref):
    # The caller supplies only its own exact-pin lists, via stdin.
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) not in (7, 8):
            continue
        kind, repo, pinned_ref, sha, card, *rest = parts
        if repo != repository.split("/")[-1] or pinned_ref != ref:
            continue
        if kind == "POSTHOC" and len(rest) == 3:
            first, decision, _ = rest
        elif kind == "DECLARED" and len(rest) == 2:
            decision, _ = rest
            first = "unknown"
        else:
            continue
        return {"sha": sha, "timingClass": kind, "card": card,
                "firstPublicAt": first, "decisionAt": decision}
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--tip", required=True)
    parser.add_argument("--policy", default=os.environ.get("DISCLOSURE_AUDIT_PROVENANCE_POLICY"))
    args = parser.parse_args()
    try:
        policy = load_policy(args.policy)
        text(args.ref, REF)
        text(args.tip, SHA)
        records = load(args.evidence, policy)
        pin = read_pin(sys.stdin.read(MAX_BYTES + 1), args.repository, args.ref)
        out = evaluate(records, args.repository, args.ref, args.tip, pin, datetime.now(timezone.utc), policy)
    except CannotEvaluate as exc:
        out = result("cannot-evaluate", [str(exc)])
    print(json.dumps(out, sort_keys=True))
    return {"consistent-snapshot": 0, "finding": 1, "cannot-evaluate": 2}[out["status"]]


if __name__ == "__main__":
    sys.exit(main())
