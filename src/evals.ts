import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { Judge, Verdict } from "./providers.js";
import { type Fact, type Store, validateId } from "./store.js";

/** A simple deterministic rule over an output; exactly one key is set. */
export type Rule =
  | { contains: string }
  | { "not-contains": string }
  | { regex: string }
  | { "max-words": number }
  | { "min-words": number };

export interface Check {
  id: string;
  description: string;
  kind: "code" | "judge";
  /** Optional condition (same shape as a rule); the check only counts when the output matches it. */
  appliesWhen?: Rule;
  /** Code checks only. */
  rule?: Rule;
}

export interface EvalCase {
  task: string;
  case: string;
  output: string;
}

export interface CheckResult {
  id: string;
  kind: "code" | "judge";
  verdict: Verdict;
  reason: string;
}

/** One run of one case. `seq` orders runs of the same case; the highest seq is the latest. */
export interface EvalRun {
  id: string;
  task: string;
  case: string;
  seq: number;
  checksVersion: number;
  judge: string;
  results: CheckResult[];
  passed: number;
  applicable: number;
  /** passed / applicable; null when no check applied. */
  score: number | null;
}

export interface Stamp {
  checksVersion: number;
  judge: string;
}

export interface TaskScore extends Stamp {
  task: string;
  score: number | null;
  cases: { case: string; runId: string; seq: number; score: number | null; passed: number; applicable: number }[];
}

export interface EvalSummary {
  generatedAt: string;
  overall: { score: number | null; judge: string; checksVersions: Record<string, number> };
  tasks: TaskScore[];
}

const AUTHOR = () => process.env.MEM_AUTHOR || "user";
const RULE_KEYS = ["contains", "not-contains", "regex", "max-words", "min-words"] as const;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ---- loading ----

function toRule(raw: unknown, where: string): Rule {
  if (!raw || typeof raw !== "object") throw new Error(`${where}: expected a rule such as {contains: "text"}`);
  const keys = Object.keys(raw).filter((k) => (RULE_KEYS as readonly string[]).includes(k));
  if (keys.length !== 1 || Object.keys(raw).length !== 1) {
    throw new Error(`${where}: use exactly one of ${RULE_KEYS.join(", ")}`);
  }
  const v = (raw as Record<string, unknown>)[keys[0]];
  if (keys[0].endsWith("words")) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where}: ${keys[0]} needs a number`);
  } else if (typeof v !== "string" || !v) {
    throw new Error(`${where}: ${keys[0]} needs a non-empty string`);
  }
  if (keys[0] === "regex") new RegExp(v as string);
  return { [keys[0]]: v } as Rule;
}

export function parseCheck(text: string, where: string): Check {
  const y = parse(text) as Record<string, unknown> | null;
  if (!y || typeof y !== "object") throw new Error(`${where}: not a YAML mapping`);
  const id = validateId(String(y.id ?? ""));
  const description = String(y.description ?? "").trim();
  if (!description) throw new Error(`${where}: description is required`);
  if (y.kind !== "code" && y.kind !== "judge") throw new Error(`${where}: kind must be code or judge`);
  const check: Check = { id, description, kind: y.kind };
  if (y["applies-when"] !== undefined) check.appliesWhen = toRule(y["applies-when"], `${where}: applies-when`);
  if (y.kind === "code") check.rule = toRule(y.rule, `${where}: rule`);
  return check;
}

/** Reads checks/<task>/*.yaml; returns task -> checks sorted by id. */
export function loadChecks(dir: string): Map<string, Check[]> {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Checks directory not found: ${dir}`);
  const tasks = new Map<string, Check[]>();
  for (const task of readdirSync(root).sort()) {
    const tdir = join(root, task);
    if (!statSync(tdir).isDirectory()) continue;
    validateId(task);
    const checks = readdirSync(tdir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => parseCheck(readFileSync(join(tdir, f), "utf8"), `${task}/${f}`))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(checks.map((c) => c.id)).size !== checks.length) throw new Error(`Duplicate check ids in task ${task}`);
    if (checks.length) tasks.set(task, checks);
  }
  if (!tasks.size) throw new Error(`No checks found in ${dir} (expected <task>/*.yaml)`);
  return tasks;
}

export function loadCases(path: string): EvalCase[] {
  const p = resolve(path);
  if (!existsSync(p)) throw new Error(`Cases file not found: ${path}`);
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<EvalCase>[];
  if (!Array.isArray(raw)) throw new Error(`${path} must be a JSON array of {task, case, output}`);
  return raw.map((c, i) => {
    if (!c.task || !c.case || typeof c.output !== "string") throw new Error(`${path}[${i}] needs task, case, output`);
    return { task: validateId(c.task), case: validateId(c.case), output: c.output };
  });
}

// ---- code checks ----

export function matchesRule(rule: Rule, output: string): boolean {
  if ("contains" in rule) return output.includes(rule.contains);
  if ("not-contains" in rule) return !output.includes(rule["not-contains"]);
  if ("regex" in rule) return new RegExp(rule.regex, "i").test(output);
  if ("max-words" in rule) return wordCount(output) <= rule["max-words"];
  return wordCount(output) >= rule["min-words"];
}

const ruleText = (r: Rule) => {
  const [k, v] = Object.entries(r)[0];
  return `${k} ${typeof v === "string" ? JSON.stringify(v) : v}`;
};

export function appliesWhen(check: Check, output: string): boolean {
  return !check.appliesWhen || matchesRule(check.appliesWhen, output);
}

export function runCodeCheck(check: Check, output: string): CheckResult {
  const ok = matchesRule(check.rule!, output);
  return {
    id: check.id,
    kind: "code",
    verdict: ok ? "pass" : "fail",
    reason: `${ok ? "satisfies" : "violates"} rule: ${ruleText(check.rule!)}`,
  };
}

// ---- scoring ----

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Run score = checks passed / checks that apply (not-applicable results are excluded). */
export function runScore(results: Pick<CheckResult, "verdict">[]): { passed: number; applicable: number; score: number | null } {
  const counted = results.filter((r) => r.verdict !== "na");
  const passed = counted.filter((r) => r.verdict === "pass").length;
  return { passed, applicable: counted.length, score: counted.length ? passed / counted.length : null };
}

/** Each case is scored by its latest run (highest seq). */
export function latestRuns(runs: EvalRun[]): EvalRun[] {
  const latest = new Map<string, EvalRun>();
  for (const r of runs) {
    const k = `${r.task}\u0000${r.case}`;
    const cur = latest.get(k);
    if (!cur || r.seq > cur.seq) latest.set(k, r);
  }
  return [...latest.values()].sort((a, b) => a.task.localeCompare(b.task) || a.case.localeCompare(b.case));
}

/** Task score = mean of its case scores; overall = mean of task scores. Cases/tasks with no applicable checks are skipped. */
export function summarize(runs: EvalRun[], judge: string, now = new Date()): EvalSummary {
  const byTask = new Map<string, EvalRun[]>();
  for (const r of latestRuns(runs)) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  const tasks: TaskScore[] = [...byTask].map(([task, rs]) => ({
    task,
    score: mean(rs.filter((r) => r.score !== null).map((r) => r.score!)),
    checksVersion: Math.max(...rs.map((r) => r.checksVersion)),
    judge: [...new Set(rs.map((r) => r.judge))].join("+"),
    cases: rs.map((r) => ({ case: r.case, runId: r.id, seq: r.seq, score: r.score, passed: r.passed, applicable: r.applicable })),
  }));
  return {
    generatedAt: now.toISOString(),
    overall: {
      score: mean(tasks.filter((t) => t.score !== null).map((t) => t.score!)),
      judge,
      checksVersions: Object.fromEntries(tasks.map((t) => [t.task, t.checksVersion])),
    },
    tasks,
  };
}

// ---- store-backed evaluation ----

const canonical = (checks: Check[]) => JSON.stringify(checks.map((c) => ({ ...c })));
const runFromFact = (f: Fact): EvalRun => ({ id: f.id, ...(JSON.parse(f.content) as Omit<EvalRun, "id">) });

export class Evals {
  constructor(
    readonly store: Store,
    readonly judge: Judge,
  ) {}

  /**
   * Record the task's checks as a kind:checks fact, the same versioning as standards: the fact version is the
   * checks version, bumped only when the definitions change.
   */
  syncChecks(task: string, checks: Check[]): number {
    const id = `checks-${task}`;
    const content = canonical(checks);
    const prior = this.store.get(id);
    if (prior && prior.kind !== "checks") throw new Error(`${id} exists and is not a checks fact`);
    if (prior && prior.content === content) return prior.version ?? 1;
    return this.store.remember({ id, content, kind: "checks", author: AUTHOR(), tags: [`task:${task}`] }).fact.version ?? 1;
  }

  listRuns(): EvalRun[] {
    return this.store.list().filter((f) => f.kind === "eval-run").map(runFromFact);
  }

  async evaluate(cases: EvalCase[], tasks: Map<string, Check[]>): Promise<EvalRun[]> {
    const versions = new Map<string, number>();
    const existing = this.listRuns();
    const nextSeq = new Map<string, number>();
    const out: EvalRun[] = [];
    const inputs = [];
    for (const c of cases) {
      const checks = tasks.get(c.task);
      if (!checks) throw new Error(`No checks for task "${c.task}"`);
      if (!versions.has(c.task)) versions.set(c.task, this.syncChecks(c.task, checks));
      const results: CheckResult[] = [];
      for (const check of checks) {
        if (!appliesWhen(check, c.output)) {
          results.push({ id: check.id, kind: check.kind, verdict: "na", reason: `applies-when not met: ${ruleText(check.appliesWhen!)}` });
        } else if (check.kind === "code") {
          results.push(runCodeCheck(check, c.output));
        } else {
          const j = await this.judge.judge(check.description, c.output);
          results.push({ id: check.id, kind: "judge", verdict: j.verdict, reason: j.reason });
        }
      }
      const key = `${c.task}--${c.case}`;
      if (!nextSeq.has(key)) {
        nextSeq.set(key, Math.max(0, ...existing.filter((r) => r.task === c.task && r.case === c.case).map((r) => r.seq)) + 1);
      }
      const seq = nextSeq.get(key)!;
      nextSeq.set(key, seq + 1);
      const run: Omit<EvalRun, "id"> = {
        task: c.task,
        case: c.case,
        seq,
        checksVersion: versions.get(c.task)!,
        judge: this.judge.name,
        results,
        ...runScore(results),
      };
      const id = `run-${key}-${seq}`;
      out.push({ id, ...run });
      inputs.push({
        id,
        content: JSON.stringify(run),
        kind: "eval-run",
        author: AUTHOR(),
        links: [`checks-${c.task}`],
        tags: [`task:${c.task}`, `case:${c.case}`, `checksVersion:${run.checksVersion}`, `judge:${run.judge}`],
      });
    }
    if (inputs.length) this.store.rememberMany(inputs, `eval: ${inputs.length} runs by ${this.judge.name}`, AUTHOR());
    return out;
  }

  summary(now = new Date()): EvalSummary {
    return summarize(this.listRuns(), this.judge.name, now);
  }
}

// ---- rendering ----

const pct = (s: number | null) => (s === null ? "n/a" : `${Math.round(s * 100)}%`);

/** The canonical eval score display, e.g. "67% (2/3) · checks=v2 · judge=mock". */
export const evalStamp = (s: { score: number | null; checksVersion: number; judge: string; passed?: number; applicable?: number }) =>
  `${pct(s.score)}${s.applicable !== undefined ? ` (${s.passed}/${s.applicable})` : ""} · checks=v${s.checksVersion} · judge=${s.judge}`;

export function renderEvalTable(sum: EvalSummary): string {
  if (!sum.tasks.length) return "(no eval runs)";
  const rows: string[][] = [["task", "case", "score"]];
  for (const t of sum.tasks) {
    for (const c of t.cases) {
      const v = t.checksVersion;
      rows.push([t.task, `${c.case} (run ${c.seq})`, evalStamp({ ...c, checksVersion: v, judge: t.judge })]);
    }
    rows.push([t.task, "TASK", evalStamp(t)]);
  }
  rows.push(["ALL", "OVERALL", `${pct(sum.overall.score)} · checks=${Object.entries(sum.overall.checksVersions).map(([k, v]) => `${k}:v${v}`).join(",")} · judge=${sum.overall.judge}`]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(rows[0]), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(fmt)].join("\n");
}
