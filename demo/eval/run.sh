#!/usr/bin/env bash
# Eval demo in a fresh temp MEM_DIR; offline with the mock judge unless JUDGE is set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
export MEM_DIR="$TMP/mem"
export MEM_AUTHOR=demo
node "$ROOT/dist/cli.js" eval --checks "$ROOT/demo/eval/checks" --cases "$ROOT/demo/eval/cases.json" \
  --judge "${JUDGE:-mock}" --feed "$TMP/eval-feed.json"
