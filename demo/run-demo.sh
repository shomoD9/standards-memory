#!/usr/bin/env bash
# End-to-end STANDARDS demo in a fresh temp MEM_DIR.
#   ./demo/run-demo.sh                 offline, deterministic (mock judge + simulated models)
#   JUDGE=claude ./demo/run-demo.sh    real CLIs (claude -p / codex exec); slower
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MEM_JUDGE="${JUDGE:-mock}"
export MEM_DIR="$(mktemp -d)/mem"
export MEM_AUTHOR=demo
[ -f "$ROOT/dist/cli.js" ] || (cd "$ROOT" && npm run build --silent)
mem() { node "$ROOT/dist/cli.js" "$@"; }
step() { printf '\n== %s\n' "$*"; }

echo "judge: $MEM_JUDGE   store: $MEM_DIR"

step "1. Add standards (v1)"
mem standard add "Is the answer under 100 words?" --id words-100 --scope a
mem standard add "Does it avoid hedging phrases?" --id no-hedging --scope a
mem standard add "Does it cite only verified sources?" --id verified-sources --scope b
mem standard add "Does code ship with tests? (n/a when no code is involved)" --id code-has-tests --scope b
mem standard add "Does it state an explicit next action or decision?" --id next-action --scope b

step "2. Score dataset A (3 prompts x claude, codex) and dataset B (sample docs)"
mem score --models claude,codex --dataset "$ROOT/demo/prompts.json" --dataset "$ROOT/demo/sample-docs"

step "3. Scores (pass / FAIL / - not applicable; vN = standard version; judge=name)"
mem scores --table

step "4. Mark a verdict wrong: a wordy answer that failed the 100-word limit was fine"
SCORE="$(mem scores --standard words-100 | awk -F'\t' '$2 ~ /^FAIL/{print $1; exit}')"
[ -n "$SCORE" ] || { echo "no failing words-100 score to dispute"; exit 1; }
mem scores --standard words-100 | grep "^$SCORE"
PROP_OUT="$(mem verdict wrong "$SCORE" --note "explanations may run up to 150 words")"
echo "$PROP_OUT"
PROP="$(echo "$PROP_OUT" | sed -n 's/^proposal \([^ ]*\) .*/\1/p')"

step "5. Accept the proposal: standard bumps to v2, its scores are rerun"
ACCEPT="$(mem proposal accept "$PROP")"
echo "$ACCEPT"
CHANGE="$(echo "$ACCEPT" | sed -n 's/.* change \([0-9a-f]*\)$/\1/p')"
mem scores --table | sed -n '1,2p;/prompt-/p'

step "6. History of the standard"
mem history words-100

step "7. Undo the acceptance (git revert of change ${CHANGE:0:12})"
mem undo "$CHANGE"
mem standard list | grep words-100
mem scores --table | sed -n '1,2p;/prompt-/p'
mem proposal list

step "8. Reject path: draft another proposal and reject it"
P2="$(mem verdict wrong "${SCORE/--words-100/--no-hedging}" --note "'it depends' is a legitimate framing here" | sed -n 's/^proposal \([^ ]*\) .*/\1/p')"
mem proposal reject "$P2"
mem proposal list
