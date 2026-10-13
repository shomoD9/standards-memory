import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator, type Judge, type Judgement, type Runner, type Verdict } from "./providers.js";
import { type Fact, type RememberInput, type Store, validateId } from "./store.js";

/** A standard is a fact (kind:standard) whose content is a yes/no question; its version is the fact version. */
export interface Standard {
  id: string;
  question: string;
  version: number;
  scope?: string;
}

export interface Output {
  id: string;
  dataset: string;
  model: string;
  source: string;
  content: string;
}

export interface ScoreRecord {
  id: string;
  outputId: string;
  standardId: string;
  standardVersion: number;
  judge: string;
  verdict: Verdict;
  reason: string;
}

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
  id: string;
  status: ProposalStatus;
  standardId: string;
  scoreId: string;
  baseVersion: number;
  original: string;
  revised: string;
  note: string;
  judge: string;
}

export interface DatasetItem {
  id: string;
  /** "a" = prompts to generate from; "b" = existing documents. */
  scope: string;
  prompt?: string;
  text?: string;
  source: string;
}

const AUTHOR = () => process.env.MEM_AUTHOR || "user";
const slug = (s: string) =>
  s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const judgeAuthor = (j: Judge) => `judge-${j.name}`;

/** Directory holding the bundled demo datasets (src/ and dist/ both sit one level below the repo root). */
export const demoDir = () => resolve(fileURLToPath(new URL("../demo", import.meta.url)));

export function loadDataset(spec: string): DatasetItem[] {
  const path = resolve(spec);
  if (!existsSync(path)) throw new Error(`Dataset not found: ${spec}`);
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
      .sort()
      .map((f) => ({
        id: `doc-${slug(f)}`,
        scope: "b",
        text: readFileSync(join(path, f), "utf8").trimEnd(),
        source: join(spec, f),
      }));
  }
  const items = JSON.parse(readFileSync(path, "utf8")) as { id?: string; prompt: string }[];
  if (!Array.isArray(items)) throw new Error(`${spec} must be a JSON array of {id, prompt}`);
  return items.map((p, i) => ({
    id: `prompt-${slug(p.id ?? `${basename(path, extname(path))}-${i + 1}`)}`,
    scope: "a",
    prompt: p.prompt,
    source: spec,
  }));
}

export function parseStandard(f: Fact): Standard {
  const scope = f.tags?.find((t) => t.startsWith("scope:"))?.slice(6);
  return { id: f.id, question: f.content, version: f.version ?? 1, ...(scope ? { scope } : {}) };
}

export function parseScore(f: Fact): ScoreRecord {
  const c = JSON.parse(f.content) as Omit<ScoreRecord, "id" | "outputId">;
  return { id: f.id, outputId: f.links[0], ...c };
}

export function parseProposal(f: Fact): Proposal {
  return { id: f.id, ...(JSON.parse(f.content) as Omit<Proposal, "id">) };
}

export interface ScoreRun {
  /** Number of scores written (new or refreshed). */
  written: number;
  /** Number skipped because they were already scored at the standard's current version. */
  skipped: number;
}

export class Standards {
  constructor(
    readonly store: Store,
    readonly judge: Judge,
    private run?: Runner,
  ) {}

  // ---- standards ----

  addStandard(question: string, o: { id?: string; scope?: string } = {}): Standard {
    const q = question.trim();
    if (!q) throw new Error("Standard question is empty");
    const id = validateId(o.id ?? `std-${slug(q).split("-").slice(0, 6).join("-")}`);
    const existing = this.store.get(id);
    if (existing && existing.kind !== "standard") throw new Error(`${id} exists and is not a standard`);
    const input: RememberInput = { id, content: q, kind: "standard", author: AUTHOR() };
    if (o.scope) input.tags = [`scope:${o.scope}`];
    return parseStandard(this.store.remember(input).fact);
  }

  getStandard(id: string): Standard {
    const f = this.store.get(id);
    if (!f || f.kind !== "standard") throw new Error(`No such standard: ${id}`);
    return parseStandard(f);
  }

  listStandards(): Standard[] {
    return this.store.list().filter((f) => f.kind === "standard").map(parseStandard);
  }

  // ---- outputs ----

  /** Generate (dataset A) or ingest (dataset B) outputs as kind:output facts; existing identical ones are reused. */
  async collectOutputs(items: DatasetItem[], models: string[]): Promise<Output[]> {
    const outputs: Output[] = [];
    const inputs: RememberInput[] = [];
    const queue = (o: Output) => {
      outputs.push(o);
      if (this.store.get(o.id)?.content !== o.content) {
        inputs.push({
          id: o.id,
          content: o.content,
          kind: "output",
          author: o.model,
          source: o.source,
          tags: [`dataset:${o.dataset}`, `model:${o.model}`],
        });
      }
    };
    for (const item of items) {
      if (item.text !== undefined) {
        queue({ id: `out-${item.id}`, dataset: item.scope, model: "human", source: item.source, content: item.text });
        continue;
      }
      for (const model of models) {
        const id = `out-${item.id}-${model}`;
        const cached = this.store.get(id);
        const content = cached?.content ?? (await createGenerator(model, this.judge.name, { run: this.run }).generate(item.prompt!));
        queue({ id, dataset: item.scope, model, source: item.source, content });
      }
    }
    if (inputs.length) this.store.rememberMany(inputs, `outputs: ${inputs.length} added`, AUTHOR());
    return outputs;
  }

  listOutputs(): Output[] {
    return this.store.list().filter((f) => f.kind === "output").map((f) => ({
      id: f.id,
      dataset: f.tags?.find((t) => t.startsWith("dataset:"))?.slice(8) ?? "",
      model: f.tags?.find((t) => t.startsWith("model:"))?.slice(6) ?? f.author,
      source: f.source,
      content: f.content,
    }));
  }

  // ---- scoring ----

  private async judgeAll(pairs: { output: Output; standard: Standard }[]): Promise<RememberInput[]> {
    const results: Judgement[] = [];
    for (let i = 0; i < pairs.length; i += 4) {
      const chunk = pairs.slice(i, i + 4);
      results.push(...(await Promise.all(chunk.map((p) => this.judge.judge(p.standard.question, p.output.content)))));
    }
    return pairs.map(({ output, standard }, i) => this.scoreInput(output.id, standard, results[i]));
  }

  private scoreInput(outputId: string, standard: Standard, j: Judgement): RememberInput {
    const record: Omit<ScoreRecord, "id" | "outputId"> = {
      standardId: standard.id,
      standardVersion: standard.version,
      judge: this.judge.name,
      verdict: j.verdict,
      reason: j.reason,
    };
    return {
      id: `score-${outputId}--${standard.id}`,
      content: JSON.stringify(record),
      kind: "score",
      author: judgeAuthor(this.judge),
      links: [outputId, standard.id],
      tags: [`standard:${standard.id}`, `standardVersion:${standard.version}`, `judge:${this.judge.name}`, `verdict:${j.verdict}`],
    };
  }

  /** Score every output against every applicable standard, skipping scores already current. */
  async score(outputs: Output[]): Promise<ScoreRun> {
    const standards = this.listStandards();
    if (!standards.length) throw new Error("No standards defined (mem standard add ...)");
    const pairs: { output: Output; standard: Standard }[] = [];
    let skipped = 0;
    for (const output of outputs) {
      for (const standard of standards) {
        if (standard.scope && standard.scope !== output.dataset) continue;
        const prior = this.store.get(`score-${output.id}--${standard.id}`);
        if (prior && parseScore(prior).standardVersion === standard.version && parseScore(prior).judge === this.judge.name) {
          skipped++;
        } else {
          pairs.push({ output, standard });
        }
      }
    }
    if (pairs.length) {
      const inputs = await this.judgeAll(pairs);
      this.store.rememberMany(inputs, `score: ${inputs.length} verdicts by ${this.judge.name}`, judgeAuthor(this.judge));
    }
    return { written: pairs.length, skipped };
  }

  listScores(): (ScoreRecord & { current: boolean })[] {
    const versions = new Map(this.listStandards().map((s) => [s.id, s.version]));
    return this.store.list().filter((f) => f.kind === "score").map((f) => {
      const s = parseScore(f);
      return { ...s, current: versions.get(s.standardId) === s.standardVersion };
    });
  }

  // ---- proposals ----

  /** A human says a verdict is wrong: the judge drafts a revised standard, recorded as a pending proposal. */
  async markWrong(scoreId: string, note = ""): Promise<Proposal> {
    const sf = this.store.get(scoreId);
    if (!sf || sf.kind !== "score") throw new Error(`No such score: ${scoreId}`);
    const score = parseScore(sf);
    const standard = this.getStandard(score.standardId);
    const output = this.store.get(score.outputId);
    if (!output) throw new Error(`Output ${score.outputId} is missing`);
    const revised = (
      await this.judge.reviseStandard({
        question: standard.question,
        output: output.content,
        verdict: score.verdict,
        reason: score.reason,
        note,
      })
    ).trim();
    if (!revised) throw new Error("Judge drafted an empty standard");
    const body: Omit<Proposal, "id"> = {
      status: "pending",
      standardId: standard.id,
      scoreId,
      baseVersion: standard.version,
      original: standard.question,
      revised,
      note,
      judge: this.judge.name,
    };
    const r = this.store.remember({
      id: `prop-${standard.id}-${Date.now().toString(36)}`,
      content: JSON.stringify(body),
      kind: "proposal",
      author: judgeAuthor(this.judge),
      links: [standard.id, scoreId],
      tags: ["status:pending"],
    });
    return parseProposal(r.fact);
  }

  getProposal(id: string): Proposal {
    const f = this.store.get(id);
    if (!f || f.kind !== "proposal") throw new Error(`No such proposal: ${id}`);
    return parseProposal(f);
  }

  listProposals(): Proposal[] {
    return this.store.list().filter((f) => f.kind === "proposal").map(parseProposal);
  }

  private proposalInput(p: Proposal, status: ProposalStatus): RememberInput {
    return {
      id: p.id,
      content: JSON.stringify({ ...p, id: undefined, status }),
      tags: [`status:${status}`],
      author: AUTHOR(),
    };
  }

  private requirePending(id: string): Proposal {
    const p = this.getProposal(id);
    if (p.status !== "pending") throw new Error(`Proposal ${id} is already ${p.status}`);
    return p;
  }

  /**
   * Apply the revised wording (standard version bump), mark the proposal accepted and rescore every output
   * previously scored against this standard — all in one commit, so `mem undo <change>` reverts the lot.
   */
  async accept(id: string): Promise<{ change: string; standard: Standard; rescored: number }> {
    const p = this.requirePending(id);
    const current = this.getStandard(p.standardId);
    const next: Standard = { ...current, question: p.revised, version: current.version + 1 };
    const outputs = new Map(this.listOutputs().map((o) => [o.id, o]));
    const pairs = this.listScores()
      .filter((s) => s.standardId === current.id && outputs.has(s.outputId))
      .map((s) => ({ output: outputs.get(s.outputId)!, standard: next }));
    const scoreInputs = await this.judgeAll(pairs);
    const { facts, change } = this.store.rememberMany(
      [
        { id: current.id, content: p.revised, author: AUTHOR() },
        this.proposalInput(p, "accepted"),
        ...scoreInputs,
      ],
      `accept ${id}: ${current.id} v${current.version} -> v${next.version}, rescored ${scoreInputs.length}`,
      AUTHOR(),
    );
    return { change, standard: parseStandard(facts[0]), rescored: scoreInputs.length };
  }

  reject(id: string): { change: string } {
    const p = this.requirePending(id);
    return { change: this.store.remember(this.proposalInput(p, "rejected")).change };
  }
}

// ---- rendering ----

const CELL: Record<Verdict, string> = { pass: "pass", fail: "FAIL", na: "-" };

/** Outputs as rows, standards as columns; each cell is the verdict plus the standard version it was scored at. */
export function renderTable(scores: (ScoreRecord & { current: boolean })[]): string {
  if (!scores.length) return "(no scores)";
  const cols = [...new Set(scores.map((s) => s.standardId))].sort();
  const rows = [...new Set(scores.map((s) => s.outputId))].sort();
  const cell = (r: string, c: string) => {
    const s = scores.find((x) => x.outputId === r && x.standardId === c);
    if (!s) return "";
    return s.verdict === "na" ? "-" : `${CELL[s.verdict]} v${s.standardVersion}${s.current ? "" : "*"}`;
  };
  const header = ["output", ...cols.map((c) => c.replace(/^std-/, ""))];
  const body = rows.map((r) => [r.replace(/^out-/, ""), ...cols.map((c) => cell(r, c))]);
  const widths = header.map((_, i) => Math.max(...[header, ...body].map((row) => row[i].length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const lines = [fmt(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(fmt)];
  if (scores.some((s) => !s.current)) lines.push("* stale: scored at a different standard version");
  return lines.join("\n");
}
