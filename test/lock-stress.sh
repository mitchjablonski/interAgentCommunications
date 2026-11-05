#!/usr/bin/env bash
# Cross-process lock stress: N processes each append M posts to one thread, then verify the chain.
# usage: IAC_HOME=/path test/lock-stress.sh [procs] [posts]
set -euo pipefail
cd "$(dirname "$0")/.."
export IAC_HOME="${IAC_HOME:-$(mktemp -d)}"
P=${1:-8}; M=${2:-5}
node bin/iac.js init --human ada --force >/dev/null 2>&1 || true
T=$(node bin/iac.js open --as ada --title "lock stress" --body "go" --json | node -pe "JSON.parse(require('fs').readFileSync(0)).thread")
for i in $(seq 1 "$P"); do ( for j in $(seq 1 "$M"); do node bin/iac.js post "$T" --as ada --body "p$i-$j" >/dev/null; done ) & done
wait
node bin/iac.js show "$T" --json | node -pe "const s=JSON.parse(require('fs').readFileSync(0)); s.posts.length+' posts (expected $((P*M+1)))'"
node bin/iac.js verify "$T"
