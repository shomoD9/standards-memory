#!/usr/bin/env bash
# Vault eval demo on a temp copy of the fictional example vault; offline (mock judge).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
V="$TMP/vault"
cp -R "$ROOT/demo/vault-eval/example-vault" "$V"
mem() { node "$ROOT/dist/cli.js" "$@"; }

echo "== 1. add checks from reviewer corrections =="
mem vault-check add --vault "$V" --from "$ROOT/demo/vault-eval/corrections.md" --judge mock
echo
echo "== 2. grade the draft (prior run passed all checks) =="
mem vault-eval --vault "$V" --draft "$V/draft.md" --judge "${JUDGE:-mock}" --report "$TMP/report.json"
code=$?
echo "exit code: $code (2 = blocked)"
echo
echo "== 3. lessons log =="
cat "$V/lessons.md"
echo "== report fields =="
node -e 'const r=require(process.argv[1]);console.log(JSON.stringify({blocked:r.blocked,criticalFailures:r.criticalFailures,regressions:r.regressions,tokenCost:r.tokenCost}))' "$TMP/report.json"
[ "$code" -eq 2 ]
