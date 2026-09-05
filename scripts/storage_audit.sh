#!/bin/bash
# TOG-782 Deliverable 1: re-runnable storage consumer map with growth rates.
#
# Re-cut 2026-09-02 -- the original 2026-08-31 run of this script was never
# committed (only reported done in an issue comment) and its output was lost
# along with the script itself in this shared workspace. Numbers below are
# fresh, not a copy of the 2026-08-31 figures cited in
# docs/tog-782-retention-proposal.md -- rerun before trusting either.
#
# Covers the three consumers named in the card: DB backups (unbounded growth
# risk), run-scratch workspace dirs (~1,195 UUID dirs at card-authoring time),
# and run-logs (candidate for the S3 mirror in Deliverable 4). Growth rates
# are derived from mtime histograms, not a stored baseline -- accuracy
# degrades if nothing has churned in the lookback window.
#
# Usage: scripts/storage_audit.sh
set -uo pipefail

PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME}"
BACKUPS_DIR="${BACKUPS_DIR:-$PAPERCLIP_HOME/instances/default/data/backups}"
STORAGE_DIR="${STORAGE_DIR:-$PAPERCLIP_HOME/instances/default/data/storage}"
RUNLOGS_DIR="${RUNLOGS_DIR:-$PAPERCLIP_HOME/instances/default/data/run-logs}"
WORKSPACES_DIR="${WORKSPACES_DIR:-$PAPERCLIP_HOME/instances/default/workspaces}"

hr() { printf '\n== %s ==\n' "$*"; }

du_of() {
  # $1=dir; prints "-" if the dir doesn't exist rather than erroring the script
  if [ -d "$1" ]; then du -sh "$1" 2>/dev/null | cut -f1; else echo "-- (missing: $1)"; fi
}

hr "Disk overview (root filesystem)"
df -h / 2>/dev/null | awk 'NR==1 || NR==2'

hr "1. DB backups -- $BACKUPS_DIR"
if [ -d "$BACKUPS_DIR" ]; then
  total=$(du_of "$BACKUPS_DIR")
  count=$(find "$BACKUPS_DIR" -maxdepth 1 -type f \( -name '*.sql.gz' -o -name '*.sql' \) 2>/dev/null | wc -l | tr -d ' ')
  inprogress=$(find "$BACKUPS_DIR" -maxdepth 1 -type f -name '*.sql' ! -name '*.sql.gz' 2>/dev/null | wc -l | tr -d ' ')
  oldest=$(find "$BACKUPS_DIR" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@ %f\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)
  newest=$(find "$BACKUPS_DIR" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)
  last24h=$(find "$BACKUPS_DIR" -maxdepth 1 -type f -name '*.sql.gz' -mtime -1 2>/dev/null | wc -l | tr -d ' ')
  echo "total size: $total"
  echo "file count (.sql.gz + in-progress .sql): $count (in-progress: $inprogress)"
  echo "oldest: $oldest"
  echo "newest: $newest"
  echo "created in last 24h: $last24h (approx growth rate, files/day)"
  bytes_per_file=$(find "$BACKUPS_DIR" -maxdepth 1 -type f -name '*.sql.gz' -printf '%s\n' 2>/dev/null | awk '{s+=$1; n++} END{if(n>0) printf "%.0f", s/n; else print 0}')
  if [ -n "$bytes_per_file" ] && [ "$bytes_per_file" -gt 0 ] 2>/dev/null; then
    growth_bytes=$((bytes_per_file * last24h))
    echo "approx bytes/day (avg file size * files created in last 24h): $growth_bytes"
  fi
else
  echo "missing: $BACKUPS_DIR"
fi

hr "2. Product storage (local_disk provider) -- $STORAGE_DIR"
echo "total size: $(du_of "$STORAGE_DIR")"
if [ -d "$STORAGE_DIR" ]; then
  find "$STORAGE_DIR" -type f 2>/dev/null | wc -l | xargs -I{} echo "file count: {}"
fi

hr "3. Run-scratch workspace dirs -- $WORKSPACES_DIR"
if [ -d "$WORKSPACES_DIR" ]; then
  total=$(du_of "$WORKSPACES_DIR")
  count=$(find "$WORKSPACES_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  last24h=$(find "$WORKSPACES_DIR" -mindepth 1 -maxdepth 1 -type d -mtime -1 2>/dev/null | wc -l | tr -d ' ')
  last7d=$(find "$WORKSPACES_DIR" -mindepth 1 -maxdepth 1 -type d -mtime -7 2>/dev/null | wc -l | tr -d ' ')
  echo "total size: $total"
  echo "dir count: $count"
  echo "touched in last 24h: $last24h"
  echo "touched in last 7d: $last7d (avg/day: $(( last7d / 7 )))"
else
  echo "missing: $WORKSPACES_DIR"
fi

hr "4. Run logs (local, pre-S3-mirror) -- $RUNLOGS_DIR"
if [ -d "$RUNLOGS_DIR" ]; then
  total=$(du_of "$RUNLOGS_DIR")
  subdirs=$(find "$RUNLOGS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  files=$(find "$RUNLOGS_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  last24h_bytes=$(find "$RUNLOGS_DIR" -type f -mtime -1 -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')
  echo "total size: $total"
  echo "run subdirectories: $subdirs"
  echo "file count: $files"
  echo "bytes written in last 24h (approx growth rate): $last24h_bytes"
else
  echo "missing: $RUNLOGS_DIR"
fi

hr "Done"
echo "Rerun this script before acting on docs/tog-782-retention-proposal.md -- all four consumers churn continuously."
