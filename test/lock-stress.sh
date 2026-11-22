#!/usr/bin/env bash
# Cross-process lock stress: N processes each append M posts to one thread, then verify the chain.
# usage: IAC_HOME=/path test/lock-stress.sh [procs] [posts]
set -euo pipefail
cd "$(dirname "$0")/.."
export IAC_HOME="${IAC_HOME:-$(mktemp -d)}"
P=${1:-8}; M=${2:-5}
node bin/iac.js init --human ada --force >/dev/null 2>&1 || true
T=$(node bin/iac.js open --as ada --title "lock stress" --body "go" --json | node -pe "JSON.parse(require('fs').readFileSync(0)).thread")
pids=()
for i in $(seq 1 "$P"); do
  ( for j in $(seq 1 "$M"); do node bin/iac.js post "$T" --as ada --body "p$i-$j" >/dev/null; done ) &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    echo "lock stress: worker $pid failed" >&2
    failed=1
  fi
done
# Reap every worker before reporting failure, including when an earlier worker fails.
if (( failed )); then exit 1; fi
node bin/iac.js show "$T" --json | node -e '
const assert = require("node:assert/strict");
const s = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const [p, m] = process.argv.slice(1).map(Number);
const expected = new Set(["go"]);
for (let i = 1; i <= p; i++) for (let j = 1; j <= m; j++) expected.add(`p${i}-${j}`);
assert.equal(s.posts.length, p * m + 1, "unexpected post count");
for (const post of s.posts) {
  assert.ok(expected.delete(post.body), `unexpected or duplicate payload: ${post.body}`);
}
assert.equal(expected.size, 0, `missing payloads: ${[...expected].join(", ")}`);
console.log(`${s.posts.length} unique posts (expected ${p * m + 1})`);
' "$P" "$M"
node bin/iac.js verify "$T"
