#!/usr/bin/env node
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { Evals, loadCases, loadChecks, renderEvalTable } from "./evals.js";
import { createJudge } from "./providers.js";
import { Standards, demoDir, loadDataset, renderTable, scoreStamp } from "./standards.js";
import { Store } from "./store.js";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string>;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
};

const collect = (v: string, prev: string[]) => [...prev, v];

/** Runs the CLI; returns the process exit code. */
export async function run(argv: string[], store?: Store, io: CliIO = defaultIO): Promise<number> {
  const s = () => (store ??= new Store());
  const program = new Command("mem")
    .description("Git-backed shared fact store")
    .exitOverride()
    .configureOutput({ writeOut: (m) => io.out(m.replace(/\n$/, "")), writeErr: (m) => io.err(m.replace(/\n$/, "")) });

  program
    .command("remember [content]")
    .description("Create or update a fact (content from arg or stdin)")
    .option("--id <id>")
    .option("--author <author>")
    .option("--source <source>")
    .option("--link <id>", "link to another fact (repeatable)", collect, [] as string[])
    .option("--tag <tag>", "tag (repeatable)", collect, [] as string[])
    .option("--kind <kind>")
    .action(async (content: string | undefined, o) => {
      const body = (content ?? (await io.readStdin())).replace(/\n$/, "");
      if (!body.trim()) throw new Error("No content given (pass an argument or pipe stdin)");
      const r = s().remember({
        id: o.id,
        content: body,
        author: o.author ?? process.env.MEM_AUTHOR,
        source: o.source,
        links: o.link.length ? o.link : undefined,
        tags: o.tag.length ? o.tag : undefined,
        kind: o.kind,
      });
      io.out(`${r.created ? "created" : "updated"} ${r.fact.id} (v${r.fact.version}) change ${r.change}`);
    });

  program
    .command("recall <query...>")
    .description("Keyword search")
    .action((q: string[]) => {
      const hits = s().recall(q.join(" "));
      if (!hits.length) io.out("(no matches)");
      for (const h of hits) io.out(`${h.fact.id}\t[${h.score}]\t${h.fact.content.split("\n")[0]}`);
    });

  program
    .command("history <id>")
    .description("Change history of a fact")
    .action((id: string) => {
      const h = s().history(id);
      if (!h.length) io.out("(no history)");
      for (const e of h) {
        io.out(`${e.change.slice(0, 12)}\t${e.timestamp}\t${e.author}\t${e.message}`);
      }
    });

  program
    .command("forget <id>")
    .description("Delete a fact")
    .option("--author <author>")
    .action((id: string, o) => {
      io.out(`forgot ${id} change ${s().forget(id, o.author ?? process.env.MEM_AUTHOR)}`);
    });

  program
    .command("undo <change>")
    .description("Revert a change (git revert)")
    .action((c: string) => {
      io.out(`reverted ${c} change ${s().undo(c)}`);
    });

  program
    .command("list")
    .description("List facts")
    .action(() => {
      const facts = s().list();
      if (!facts.length) io.out("(empty)");
      for (const f of facts) io.out(`${f.id}\tv${f.version ?? 1}\t${f.author}\t${f.content.split("\n")[0]}`);
    });

  program
    .command("show <id>")
    .description("Show a fact")
    .action((id: string) => {
      const f = s().get(id);
      if (!f) throw new Error(`No such fact: ${id}`);
      io.out(JSON.stringify({ ...f, backlinks: s().links(id).incoming }, null, 2));
    });

  const judgeOpt = ["--judge <name>", "judge provider: claude | codex | mock (default: $MEM_JUDGE or mock)"] as const;
  const std = (o: { judge?: string }) => new Standards(s(), createJudge(o.judge));

  const standard = program.command("standard").description("Manage standards (yes/no questions)");
  standard
    .command("add <question>")
    .description("Add a standard, or reword an existing one with --id (bumps its version)")
    .option("--id <id>")
    .option("--scope <scope>", "only apply to dataset a (prompts) or b (documents)")
    .action((q: string, o) => {
      const r = std({}).addStandard(q, o);
      io.out(`${r.id} v${r.version}: ${r.question}`);
    });
  standard
    .command("list")
    .description("List standards")
    .action(() => {
      const all = std({}).listStandards();
      if (!all.length) io.out("(none)");
      for (const x of all) io.out(`${x.id}\tv${x.version}\t${x.scope ?? "all"}\t${x.question}`);
    });

  program
    .command("score")
    .description("Generate/ingest outputs and score them against all standards")
    .option("--models <list>", "comma-separated models for prompt datasets", "claude,codex")
    .option("--dataset <path>", "prompts .json or directory of documents (repeatable; default: bundled demo sets)", collect, [] as string[])
    .option(...judgeOpt)
    .action(async (o) => {
      const d = demoDir();
      const specs: string[] = o.dataset.length ? o.dataset : [`${d}/prompts.json`, `${d}/sample-docs`];
      const models = String(o.models).split(",").map((m) => m.trim()).filter(Boolean);
      const x = std(o);
      const outputs = await x.collectOutputs(specs.flatMap(loadDataset), models);
      const r = await x.score(outputs);
      io.out(`scored with ${x.judge.name}: ${r.written} written, ${r.skipped} already current`);
    });

  program
    .command("scores")
    .description("Show scores")
    .option("--table", "matrix of outputs x standards")
    .option("--standard <id>", "only this standard")
    .action((o) => {
      const all = std({}).listScores().filter((x) => !o.standard || x.standardId === o.standard);
      if (o.table) return io.out(renderTable(all));
      if (!all.length) io.out("(no scores)");
      for (const x of all) {
        io.out(`${x.id}\t${scoreStamp(x)}${x.current ? "" : " (stale)"}\tstd ${x.standardId}\t${x.reason}`);
      }
    });

  program
    .command("verdict")
    .description("Challenge a verdict")
    .command("wrong <scoreId>")
    .description("Mark a score wrong; the judge drafts a revised standard as a proposal")
    .option("--note <text>", "why the verdict is wrong")
    .option(...judgeOpt)
    .action(async (id: string, o) => {
      const p = await std(o).markWrong(id, o.note);
      io.out(`proposal ${p.id} (pending)\n  was: ${p.original}\n  now: ${p.revised}`);
    });

  const proposal = program.command("proposal").description("Review proposed standard rewordings");
  proposal
    .command("list")
    .description("List proposals")
    .action(() => {
      const all = std({}).listProposals();
      if (!all.length) io.out("(none)");
      for (const p of all) io.out(`${p.id}\t${p.status}\t${p.standardId}\t${p.revised}`);
    });
  proposal
    .command("accept <id>")
    .description("Apply the revision (standard version bump) and rescore; undo with `mem undo <change>`")
    .option(...judgeOpt)
    .action(async (id: string, o) => {
      const r = await std(o).accept(id);
      io.out(`accepted ${id}: ${r.standard.id} now v${r.standard.version}, rescored ${r.rescored} change ${r.change}`);
    });
  proposal
    .command("reject <id>")
    .description("Reject the proposal; the standard is unchanged")
    .action((id: string) => {
      io.out(`rejected ${id} change ${std({}).reject(id).change}`);
    });

  program
    .command("eval")
    .description("Run evals: cases through code checks and the judge; prints a table and writes a JSON feed")
    .option("--checks <dir>", "checks directory (<task>/*.yaml)", "checks")
    .option("--cases <file>", "JSON array of {task, case, output}")
    .option("--feed <path>", "JSON feed output path", "eval-feed.json")
    .option(...judgeOpt)
    .action(async (o) => {
      if (!o.cases) throw new Error("--cases <file> is required");
      const e = new Evals(s(), createJudge(o.judge));
      await e.evaluate(loadCases(o.cases), loadChecks(o.checks));
      const sum = e.summary();
      writeFileSync(o.feed, JSON.stringify(sum, null, 2) + "\n");
      io.out(renderEvalTable(sum));
      io.out(`feed: ${o.feed}`);
    });

  program
    .command("web")
    .description("Open the local web view")
    .option("--port <port>", "listen port", "4747")
    .action(async (o) => {
      if (!/^\d+$/.test(o.port)) throw new Error("Invalid port");
      const { startWeb } = await import("./web.js");
      const server = await startWeb(s(), Number(o.port));
      const address = server.address();
      io.out(`Memory web view: http://127.0.0.1:${typeof address === "object" && address ? address.port : o.port}`);
    });

  program
    .command("mcp")
    .description("Run the MCP server on stdio")
    .action(async () => {
      const { startMcp } = await import("./mcp.js");
      await startMcp(s());
      await new Promise(() => {}); // stay alive while the transport is open
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  run(process.argv.slice(2)).then((code) => {
    if (code !== 0 || !["mcp", "web"].includes(process.argv[2])) process.exit(code);
  });
}
