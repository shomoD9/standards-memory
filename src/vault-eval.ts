import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { matchesRule, toRule, type Rule } from "./evals.js";
import { createGenerator, createJudge, type Judge, type Verdict } from "./providers.js";

export type Severity = "critical" | "normal";

export interface VaultCheck {
  id: string;
  /** The human reviewer's original note. */
  correction: string;
  /** Yes/no question for the judge. */
  criterion: string;
  /** Optional deterministic rule; when set it is evaluated by code and the judge is skipped. */
  rule?: Rule;
  severity: Severity;
  date: string;
}

export interface VaultResult {
  id: string;
  severity: Severity;
  verdict: Verdict;
  criterion: string;
  /** One short sentence, kept for the lessons log. Not a grader transcript. */
  reason: string;
  regression: boolean;
}

export interface VaultReport {
  vault: string;
  draft: string;
  judge: string;
  date: string;
  passed: number;
  applicable: number;
  score: number | null;
  blocked: boolean;
  criticalFailures: string[];
  regressions: string[];
  results: VaultResult[];
  /** Placeholder for callers to fill in later; no accounting is done here. */
  tokenCost: number | null;
}

export const CHECKS_FILE = "checks.md";
export const LESSONS_FILE = "lessons.md";
export const LAST_EVAL_FILE = ".last-eval.json";

const FENCE = /^```check[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const HEADER = "# Checks\n\nEach check is a fenced `check` block (YAML). See the README, \"Vault checks.md\".\n";

// ---- checks.md ----

export function parseChecks(md: string, where = CHECKS_FILE): VaultCheck[] {
  const checks: VaultCheck[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(FENCE)) {
    const y = parse(m[1]) as Record<string, unknown> | null;
    const at = `${where}: check ${y?.id ?? "(no id)"}`;
    if (!y || typeof y !== "object") throw new Error(`${at}: expected a YAML mapping`);
    for (const k of ["id", "correction", "severity", "date"]) {
      if (typeof y[k] !== "string" || !y[k]) throw new Error(`${at}: missing "${k}"`);
    }
    if (y.severity !== "critical" && y.severity !== "normal") throw new Error(`${at}: severity must be critical or normal`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(y.date as string)) throw new Error(`${at}: date must be YYYY-MM-DD`);
    if (y.criterion !== undefined && typeof y.criterion !== "string") throw new Error(`${at}: criterion must be a string`);
    if (!y.criterion && !y.rule) throw new Error(`${at}: needs a criterion (and/or a rule)`);
    if (seen.has(y.id as string)) throw new Error(`${at}: duplicate id`);
    seen.add(y.id as string);
    checks.push({
      id: y.id as string,
      correction: y.correction as string,
      criterion: (y.criterion as string) || `Does the draft satisfy rule ${JSON.stringify(y.rule)}?`,
      ...(y.rule !== undefined ? { rule: toRule(y.rule, `${at}: rule`) } : {}),
      severity: y.severity,
      date: y.date as string,
    });
  }
  return checks;
}

export function loadVaultChecks(vault: string): VaultCheck[] {
  const p = join(vault, CHECKS_FILE);
  if (!existsSync(p)) throw new Error(`No ${CHECKS_FILE} in ${vault}`);
  return parseChecks(readFileSync(p, "utf8"), p);
}

export function renderCheck(c: VaultCheck): string {
  const y: Record<string, unknown> = { id: c.id, severity: c.severity, date: c.date, correction: c.correction, criterion: c.criterion };
  if (c.rule) y.rule = c.rule;
  return "```check\n" + stringify(y, { lineWidth: 0 }) + "```\n";
}

// ---- corrections -> checks ----

export interface Correction {
  text: string;
  severity: Severity;
}

/** Corrections are bullets, or blank-line separated paragraphs if there are no bullets. A leading `[critical]` or `critical:` marks severity. */
export function parseCorrections(text: string): Correction[] {
  const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
  const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
  const chunks: string[] = [];
  if (lines.some((l) => bullet.test(l))) {
    for (const l of lines) {
      const b = bullet.exec(l);
      if (b) chunks.push(b[1]);
      else if (l.trim() && chunks.length && /^\s+/.test(l)) chunks[chunks.length - 1] += " " + l.trim();
    }
  } else {
    chunks.push(...lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ")));
  }
  const out: Correction[] = [];
  for (const raw of chunks) {
    const m = /^\s*(?:\[critical\]|critical:)\s*/i.exec(raw);
    const body = raw.slice(m ? m[0].length : 0).trim();
    if (body) out.push({ text: body, severity: m ? "critical" : "normal" });
  }
  return out;
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-").slice(0, 40).replace(/-+$/, "") || "check";

/** Offline heuristic: turn a correction into a yes/no question. */
export function heuristicCriterion(text: string): string {
  const t = text.trim().replace(/[.!\s]+$/, "");
  const neg = /^(?:please\s+)?(?:don'?t|do not|never|avoid|stop)\s+(.*)$/i.exec(t);
  if (neg) return `Does the draft avoid this: ${neg[1]}?`;
  return `Does the draft follow this reviewer correction: "${t}"?`;
}

export interface AddOptions {
  judge?: string;
  date?: string;
  /** Test hook: phrase criteria without a real model. */
  phrase?: (text: string) => Promise<string>;
}

export interface AddResult {
  added: VaultCheck[];
  skipped: { id: string; reason: string }[];
}

async function phraseCriterion(text: string, judgeName: string, o: AddOptions): Promise<string> {
  if (o.phrase) return o.phrase(text);
  if (judgeName === "mock") return heuristicCriterion(text);
  const prompt = [
    "Rewrite this human reviewer correction as ONE yes/no question that a grader can answer about a draft.",
    'A "yes" answer must mean the draft is correct. Reply with ONLY the question.',
    "",
    `CORRECTION: ${text}`,
  ].join("\n");
  try {
    const q = (await createGenerator(judgeName, judgeName).generate(prompt)).split("\n").map((l) => l.trim()).find(Boolean);
    if (q) return q.replace(/^QUESTION:\s*/i, "");
  } catch {
    /* fall back to the heuristic */
  }
  return heuristicCriterion(text);
}

export async function addChecks(vault: string, corrections: Correction[], o: AddOptions = {}): Promise<AddResult> {
  const path = join(vault, CHECKS_FILE);
  const existing = existsSync(path) ? parseChecks(readFileSync(path, "utf8"), path) : [];
  const ids = new Set(existing.map((c) => c.id));
  const known = new Set(existing.map((c) => c.correction.trim().toLowerCase()));
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const judgeName = o.judge ?? process.env.MEM_JUDGE ?? "mock";
  const result: AddResult = { added: [], skipped: [] };
  let out = existsSync(path) ? readFileSync(path, "utf8") : HEADER;
  for (const c of corrections) {
    const base = slug(c.text);
    if (known.has(c.text.toLowerCase())) {
      result.skipped.push({ id: base, reason: "correction already has a check" });
      continue;
    }
    let id = base;
    if (ids.has(id)) id = `${base.slice(0, 35)}-${createHash("sha1").update(c.text).digest("hex").slice(0, 4)}`;
    const check: VaultCheck = { id, correction: c.text, criterion: await phraseCriterion(c.text, judgeName, o), severity: c.severity, date };
    ids.add(id);
    known.add(c.text.toLowerCase());
    out = out.replace(/\n*$/, "\n\n") + renderCheck(check);
    result.added.push(check);
  }
  if (result.added.length) writeFileSync(path, out);
  return result;
}

// ---- runner ----

export interface GradeOptions {
  judge?: Judge;
  /** Prior report to detect regressions against; defaults to <vault>/.last-eval.json when it exists. */
  prior?: VaultReport | null;
  date?: string;
  draftName?: string;
}

export function loadReport(path: string): VaultReport | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as VaultReport;
}

/** Judge name for the vault runner: --judge, then MEM_VAULT_JUDGE, then codex. */
export const vaultJudgeName = (flag?: string) => flag || process.env.MEM_VAULT_JUDGE || "codex";

export async function gradeDraft(checks: VaultCheck[], draft: string, vault: string, o: GradeOptions = {}): Promise<VaultReport> {
  const judge = o.judge ?? createJudge(vaultJudgeName());
  const prior = o.prior === undefined ? loadReport(join(vault, LAST_EVAL_FILE)) : o.prior;
  const was = new Map((prior?.results ?? []).map((r) => [r.id, r.verdict]));
  const results: VaultResult[] = [];
  for (const c of checks) {
    let verdict: Verdict;
    let reason: string;
    if (c.rule) {
      const ok = matchesRule(c.rule, draft);
      verdict = ok ? "pass" : "fail";
      reason = `${ok ? "satisfies" : "violates"} rule ${JSON.stringify(c.rule)}`;
    } else {
      ({ verdict, reason } = await judge.judge(c.criterion, draft));
    }
    reason = reason.replace(/\s+/g, " ").trim().slice(0, 200);
    results.push({ id: c.id, severity: c.severity, verdict, criterion: c.criterion, reason, regression: verdict === "fail" && was.get(c.id) === "pass" });
  }
  const applicable = results.filter((r) => r.verdict !== "na");
  const passed = applicable.filter((r) => r.verdict === "pass").length;
  const criticalFailures = results.filter((r) => r.verdict === "fail" && r.severity === "critical").map((r) => r.id);
  return {
    vault,
    draft: o.draftName ?? "(stdin)",
    judge: judge.name,
    date: o.date ?? new Date().toISOString().slice(0, 10),
    passed,
    applicable: applicable.length,
    score: applicable.length ? passed / applicable.length : null,
    blocked: criticalFailures.length > 0,
    criticalFailures,
    regressions: results.filter((r) => r.regression).map((r) => r.id),
    results,
    tokenCost: null,
  };
}

/** Append one short lesson per failed check to the vault's lessons log. */
export function appendLessons(vault: string, report: VaultReport): number {
  const fails = report.results.filter((r) => r.verdict === "fail");
  if (!fails.length) return 0;
  const path = join(vault, LESSONS_FILE);
  const head = existsSync(path) ? "\n" : "# Lessons\n\n";
  const body = fails
    .map((r) =>
      [
        `## ${report.date} · ${r.id} (${r.severity})${r.regression ? " · regression" : ""}`,
        `- Criterion: ${r.criterion}`,
        `- Note: ${r.reason}`,
        "",
      ].join("\n"),
    )
    .join("\n");
  appendFileSync(path, head + body + "\n");
  return fails.length;
}

export function renderVaultReport(r: VaultReport): string {
  const w = Math.max(2, ...r.results.map((x) => x.id.length));
  const lines = [`vault ${r.vault} · draft ${r.draft} · judge=${r.judge}`, ""];
  for (const x of r.results) {
    const flags = [x.severity === "critical" ? "critical" : "", x.regression ? "REGRESSION" : ""].filter(Boolean).join(" ");
    lines.push(`${x.verdict.toUpperCase().padEnd(4)}  ${x.id.padEnd(w)}  ${flags}`.trimEnd());
  }
  lines.push("", `score: ${r.passed}/${r.applicable}${r.score === null ? "" : ` (${Math.round(r.score * 100)}%)`}`);
  if (r.regressions.length) lines.push(`regressions: ${r.regressions.join(", ")}`);
  lines.push(`blocked: ${r.blocked}`);
  if (r.blocked) lines.push(`critical failures: ${r.criticalFailures.join(", ")}`);
  return lines.join("\n");
}
