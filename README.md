# standards-memory

Git-backed fact memory for agent teams. Agents share Markdown facts with YAML
frontmatter: author, timestamp, source, links, tags, kind, and version. Writes and
deletes become Git commits; history records earlier contents, and undo uses
`git revert`. Links and backlinks form a graph. Recall is case-insensitive keyword
search: all terms must match, ranked by occurrence count.

## Install and build

Requires Node.js 20+ and Git. From this repository:

```sh
npm ci
npm run build
npm link                 # installs the local mem and mem-mcp commands
mem --help
```

Without `npm link`, use `node dist/cli.js` in place of `mem`. Run tests with
`npm test`.

The store initializes its own Git repository at `./.mem` by default. Set
`MEM_DIR` to an absolute path so CLI, MCP clients, and the web view share the same
store. `MEM_AUTHOR` supplies the CLI author when omitted.

## CLI

```sh
mem remember "MRR excludes one-time fees." --id mrr --author duck-bot --source meeting
mem remember "Use the agreed MRR definition." --link mrr --tag finance
mem recall recurring revenue
mem list
mem show mrr
mem history mrr
mem forget mrr
mem undo <change-sha>
```

`remember` accepts content as an argument or stdin. Reusing `--id` updates the
fact and increments its version. It also accepts `--kind`, repeatable `--link`,
and repeatable `--tag`. `show` includes backlinks. Mutations return a change SHA
for undo; a revert can fail if later changes conflict.

## MCP server

The stdio server exposes `remember`, `recall`, and `history`. It can also be
started with `mem mcp` or `mem-mcp`.

For Claude Code, after building, run from the repository root:

```sh
claude mcp add mem -- node dist/mcp-bin.js
```

For use from other directories, use an absolute script path and explicitly set
`MEM_DIR`:

```sh
claude mcp add mem --env MEM_DIR=/absolute/path/to/shared-memory -- node /absolute/path/to/standards-memory/dist/mcp-bin.js
```

For Codex, add this to `~/.codex/config.toml`, replacing the example paths:

```toml
[mcp_servers.mem]
command = "node"
args = ["/absolute/path/to/standards-memory/dist/mcp-bin.js"]

[mcp_servers.mem.env]
MEM_DIR = "/absolute/path/to/shared-memory"
```

See the [official Codex MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Local web view

```sh
mem web
# or: mem web --port 8080
```

Open `http://127.0.0.1:4747`. Browse and search facts, follow links and backlinks,
inspect fact history and the graph, and undo recent commits. The view uses the
same `MEM_DIR` and listens only on `127.0.0.1`.

## Standards demo

The demo applies versioned yes/no standards to outputs. Scores are linked facts
recording pass, fail, or not applicable, a reason, the judge, and the standard ID
and version. A disputed verdict prompts a proposed standard revision. Accepting
it bumps the standard version and rescores its previously scored outputs in one
commit; undo reverts that acceptance. Rejected proposals remain recorded.
Earlier score contents are available through Git history.

Two bundled datasets:

- **A — model prompts:** [demo/prompts.json](demo/prompts.json), three tasks about
  engineer onboarding, REST versus GraphQL, and weekly updates, run through
  Claude and Codex (simulated in mock mode).
- **B — sample documents:** [demo/sample-docs/](demo/sample-docs/), four fictional
  documents for a made-up company, "Acme Notes": a product brief, a review of that
  brief, a project scope, and a few backlog tickets. All content is invented.

```sh
npm run demo                         # offline mock judge and simulated models
JUDGE=claude ./demo/run-demo.sh       # real Claude judge; Claude and Codex outputs
```

The real run requires installed, authenticated `claude` and `codex` CLIs. Each
run creates a fresh temporary store and prints its path. The scripted dispute
requires a generated answer to fail the initial 100-word standard; a real run
stops if none does. Mock scores demonstrate the workflow, not model quality.

The standards commands are:

```sh
mem standard add "Is the answer under 100 words?" --id words-100 --scope a
mem standard list
mem score --judge mock --models claude,codex
mem scores --table
mem scores --standard words-100
mem verdict wrong <score-id> --note "Explanations may run up to 150 words" --judge mock
mem proposal list
mem proposal accept <proposal-id> --judge mock
mem proposal reject <proposal-id>
mem undo <acceptance-change-sha>
```

`standard add --id` also rewords an existing standard. Scope `a` applies to
prompts and `b` to documents; omit it for both. `score` defaults to the bundled
datasets; repeat `--dataset <path>` for prompt JSON files or document directories.
Judge selection uses `--judge` or `MEM_JUDGE`: `mock` (default), `claude`, or `codex`.

## Evals

Checks are files, `checks/<task>/*.yaml`, with
`id`, `description`, `kind` (`code` or `judge`), and an optional `applies-when`
condition. A code check also has a `rule`: one of `contains`, `not-contains`,
`regex` (case-insensitive), `max-words`, or `min-words`. `applies-when` takes the
same shape and is tested against the output; a check whose condition fails is not
applicable. Judge checks send the description to the judge as a yes/no question
(a judge `na` also means not applicable).

```sh
mem eval --checks checks --cases cases.json --judge mock --feed eval-feed.json
npm run eval:demo        # demo/eval, mock judge, temp store
```

`cases.json` is an array of `{task, case, output}`. Each task's checks are recorded
as a `checks-<task>` fact, so the checks version is its fact version, bumped only
when the definitions change (same mechanism as standards). Each run is stored as an
`eval-run` fact. Run score = checks passed / checks that apply. Each case is scored
by its latest run; task score = mean of its cases; overall = mean of tasks (cases
and tasks with no applicable checks are skipped). Every score shows
`checks=vN · judge=name`. Output is a table on stdout and a JSON feed
(`--feed`, default `eval-feed.json`). Judge selection is `--judge` or `MEM_JUDGE`.

## Vault checks.md and the draft grader

A separate, generic subsystem for agent vaults (a vault is just a directory). It
is distinct from the per-task `checks/<task>/*.yaml` evals above. Demo content is
fictional (an "Acme Notes" writer agent) under `demo/vault-eval/`.

**checks.md.** Each check is a fenced `check` block of YAML inside Markdown, so
people and agents can edit it by hand. Fields: `id` (stable slug), `severity`
(`critical` or `normal`), `date` (ISO), `correction` (the reviewer's original
note), `criterion` (a yes/no question where "yes" means the draft is fine), and an
optional `rule` (one of `contains`, `not-contains`, `regex`, `max-words`,
`min-words`) that code evaluates instead of the judge. Start from
`demo/vault-eval/template/checks.md`; a filled example is in
`demo/vault-eval/example-vault/`.

**Corrections to checks.**

```sh
mem vault-check add --vault my-vault --from corrections.md   # or pipe stdin
```

Each bullet (or blank-line separated paragraph) becomes one check. A leading
`[critical]` or `critical:` sets severity; the default is `normal`. Ids come from
the correction text; a correction that already has a check is skipped, and an id
clash gets a short hash suffix. `--judge mock` (the default) phrases the criterion
with a plain heuristic, offline. `--judge claude|codex` asks a model to phrase it.

**Runner.**

```sh
mem vault-eval --vault my-vault --draft draft.md      # or --draft - / stdin
```

It grades the draft against all checks and prints PASS/FAIL/NA per check plus
`score: passed/applicable`. The judge is Codex (`codex exec`) by default; use
`--judge mock|codex|claude` or `MEM_VAULT_JUDGE`. The JSON report goes to
`--report` (default `<vault>/.last-eval.json`) and has a `tokenCost` placeholder
(`null`; nothing is counted).

**Critical blocking.** If any `critical` check fails, the draft is `blocked`
whatever the score is. The output and JSON show `blocked: true` and
`criticalFailures`, and the exit code is 2. Otherwise it is 0.

**Lessons and regressions.** Each failed check appends a short entry to
`<vault>/lessons.md`: check id, criterion, and a one-line note (`--no-lessons`
skips this). Grader reasoning is not shown in the table. If the prior report
(`<vault>/.last-eval.json`, or `--prior <path>`) had a check passing and it now
fails, it is flagged `regression: true` and listed under `regressions`.

```sh
npm run vault-eval:demo   # mock judge on a temp copy of the example vault; ends blocked, exit 2 from the CLI
```

The mock judge is keyword-based, so it is only good enough for the demo and tests.

## Not in v0

Embeddings or vector search, hosting, multi-user support, and authentication.

See [BUILD_LOG.md](BUILD_LOG.md) for build attribution.
