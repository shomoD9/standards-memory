import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  Evals, appliesWhen, evalStamp, latestRuns, loadChecks, parseCheck, runScore, summarize, type Check, type EvalRun,
} from "../src/evals.js";
import { createJudge } from "../src/providers.js";
import { tempStore } from "./helpers.js";

const code = (id: string, rule: Check["rule"], appliesWhen?: Check["appliesWhen"]): Check => ({
  id, description: id, kind: "code", rule, ...(appliesWhen ? { appliesWhen } : {}),
});
const checks = (): Check[] => [
  code("short", { "max-words": 5 }),
  code("owner", { contains: "owner" }, { contains: "action" }),
];
const mk = (task: string, c: string, seq: number, score: number | null, v = 1): EvalRun => ({
  id: `run-${task}-${c}-${seq}`, task, case: c, seq, checksVersion: v, judge: "mock", results: [], passed: 0, applicable: 0, score,
});

describe("scoring", () => {
  it("run score = passed / applicable, excluding n/a", () => {
    expect(runScore([{ verdict: "pass" }, { verdict: "fail" }, { verdict: "na" }, { verdict: "pass" }])).toEqual({ passed: 2, applicable: 3, score: 2 / 3 });
    expect(runScore([{ verdict: "na" }]).score).toBeNull();
  });

  it("task = mean of cases, overall = mean of tasks", () => {
    const s = summarize([mk("a", "1", 1, 1), mk("a", "2", 1, 0), mk("b", "1", 1, 0.5)], "mock");
    expect(s.tasks.map((t) => t.score)).toEqual([0.5, 0.5]);
    expect(s.overall.score).toBe(0.5);
    expect(summarize([mk("a", "1", 1, 1), mk("b", "1", 1, 0)], "mock").overall.score).toBe(0.5);
  });

  it("each case is scored by its latest run, not the best or first", () => {
    const runs = [mk("a", "1", 2, 0.2), mk("a", "1", 10, 0.4), mk("a", "1", 3, 1)];
    expect(latestRuns(runs).map((r) => r.seq)).toEqual([10]);
    expect(summarize(runs, "mock").tasks[0].score).toBe(0.4);
  });
});

describe("applies-when", () => {
  it("skips checks whose condition is not met", () => {
    const owner = checks()[1];
    expect(appliesWhen(owner, "one action item")).toBe(true);
    expect(appliesWhen(owner, "nothing here")).toBe(false);
  });

  it("n/a checks do not count against the run", async () => {
    const e = new Evals(tempStore(), createJudge("mock"));
    const [r] = await e.evaluate([{ task: "t", case: "c", output: "two words" }], new Map([["t", checks()]]));
    expect(r.results.find((x) => x.id === "owner")?.verdict).toBe("na");
    expect(r).toMatchObject({ passed: 1, applicable: 1, score: 1 });
  });
});

describe("evals with the store", () => {
  it("stamps checks version, bumping only when checks change", async () => {
    const e = new Evals(tempStore(), createJudge("mock"));
    const t = (c: Check[]) => new Map([["t", c]]);
    const out = { task: "t", case: "c", output: "hi" };
    const [r1] = await e.evaluate([out], t(checks()));
    const [r2] = await e.evaluate([out], t(checks()));
    const [r3] = await e.evaluate([out], t([code("short", { "max-words": 1 })]));
    expect([r1, r2, r3].map((r) => r.checksVersion)).toEqual([1, 1, 2]);
    expect([r1, r2, r3].map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(e.listRuns()).toHaveLength(3);
    const sum = e.summary();
    expect(sum.tasks[0]).toMatchObject({ checksVersion: 2, judge: "mock" });
    expect(sum.tasks[0].cases[0].seq).toBe(3);
    expect(evalStamp({ ...r3, judge: "mock" })).toContain("checks=v2 · judge=mock");
  });

  it("uses the judge for judge checks and stamps its name", async () => {
    const e = new Evals(tempStore(), createJudge("mock"));
    const judged: Check = { id: "hedge", description: "Does it avoid hedging phrases?", kind: "judge" };
    const [r] = await e.evaluate([{ task: "t", case: "c", output: "I think so" }], new Map([["t", [judged]]]));
    expect(r.results[0]).toMatchObject({ kind: "judge", verdict: "fail" });
    expect(r.judge).toBe("mock");
  });
});

describe("loading and CLI", () => {
  it("parses check files and rejects bad ones", () => {
    expect(parseCheck("id: a\ndescription: d\nkind: code\nrule:\n  regex: x\n", "f").rule).toEqual({ regex: "x" });
    expect(() => parseCheck("id: a\ndescription: d\nkind: code\n", "f")).toThrow(/rule/);
    expect(() => parseCheck("id: a\ndescription: d\nkind: nope\n", "f")).toThrow(/kind/);
  });

  it("mem eval prints a table and writes the feed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-"));
    mkdirSync(join(dir, "checks", "t"), { recursive: true });
    writeFileSync(join(dir, "checks", "t", "a.yaml"), "id: a\ndescription: d\nkind: code\nrule:\n  contains: ok\n");
    expect(loadChecks(join(dir, "checks")).get("t")).toHaveLength(1);
    writeFileSync(join(dir, "cases.json"), JSON.stringify([{ task: "t", case: "c1", output: "ok" }, { task: "t", case: "c2", output: "no" }]));
    const lines: string[] = [];
    const feed = join(dir, "feed.json");
    const code = await run(
      ["eval", "--checks", join(dir, "checks"), "--cases", join(dir, "cases.json"), "--feed", feed, "--judge", "mock"],
      tempStore(),
      { out: (s) => lines.push(s), err: () => {}, readStdin: async () => "" },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("checks=v1 · judge=mock");
    const f = JSON.parse(readFileSync(feed, "utf8"));
    expect(f.overall.score).toBe(0.5);
    expect(f.tasks[0].cases).toHaveLength(2);
  });
});
