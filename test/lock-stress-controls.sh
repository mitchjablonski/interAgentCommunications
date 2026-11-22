#!/usr/bin/env bash
# Benign local fault controls for the stress harness; no shared board is used.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export REAL_NODE
REAL_NODE=$(command -v node)
mkdir "$tmp/bin"
cat >"$tmp/bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ ${1:-} == bin/iac.js && ${2:-} == post ]]; then
  body=${args[${#args[@]}-1]}
  if [[ $body == p1-1 ]]; then
    case ${CONTROL:-} in
      missing) exit 0 ;;
      duplicate) args[${#args[@]}-1]=p1-2 ;;
      failed) exit 17 ;;
    esac
  fi
  if [[ ${CONTROL:-} == failed && $body == p2-1 ]]; then
    sleep 1
    "$REAL_NODE" "${args[@]}"
    touch "$FINISHED"
    exit 0
  fi
fi
exec "$REAL_NODE" "${args[@]}"
SH
chmod +x "$tmp/bin/node"
export PATH="$tmp/bin:$PATH"
export FINISHED="$tmp/finished"
for control in clean missing duplicate failed; do
  export CONTROL="$control" IAC_HOME="$tmp/$control"
  if bash test/lock-stress.sh 2 2 >"$tmp/$control.log" 2>&1; then
    if [[ $control != clean ]]; then
      cat "$tmp/$control.log"
      echo "control $control unexpectedly passed" >&2
      exit 1
    fi
  else
    if [[ $control == clean ]]; then cat "$tmp/$control.log"; exit 1; fi
    case $control in
      missing) grep -q 'unexpected post count' "$tmp/$control.log" ;;
      duplicate) grep -q 'unexpected or duplicate payload' "$tmp/$control.log" ;;
      failed) grep -q 'worker .* failed' "$tmp/$control.log"; test -f "$FINISHED" ;;
    esac
  fi
  echo "$control control passed"
done
