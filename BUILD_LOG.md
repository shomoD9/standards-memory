# Build log

## 2026-10-13 — Day 1

The scope was approved.

- Store, CLI, and MCP server: built by Claude Code.
- Local web view: built by Codex.
- Standards demo: built by Claude Code.
- README: written by Codex.

Duck Bot planned, prompted, reviewed, and committed the work.
Duck Bot wrote no application code.

## 2026-10-13 (later): real-judge runs

Duck Bot ran `demo/run-demo.sh` with `JUDGE=claude` (exit 0, 2m03s) and `JUDGE=codex` (exit 0, 3m00s). All 8 steps completed. Scores were stamped v1/v2 correctly; accepting the proposal rescored 6 outputs at v2; undo restored v1 wording and v1 scores; the reject path worked. No code fixes were needed. Tests still passed 28/28.

Observations: with real generators, every answer failed "under 100 words" at v1 (models answer long by default). The claude judge's v2 wording ("roughly 150 words, not counting headings...") still failed 3 claude answers, while the codex judge's v2 passed all 6, showing judges disagree.

## 2026-10-13 (later still): score stamps

Every score now displays both standard version and judge name, e.g. `FAIL v2 · judge=codex` / `pass v1 · judge=mock`, in `mem scores`, the table, demo output and the web view. Written by Claude Code, directed by Duck Bot.

## 2026-10-13 (evals): Evals

Evals written by Claude Code, directed by Duck Bot.
Scrub for public release: internal demo docs replaced with fictional samples and history rewritten (written by Claude Code, directed by Duck Bot).
