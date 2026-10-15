import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { MockProvider } from "../src/providers.js";
import { addChecks, appendLessons, gradeDraft, loadVaultChecks, parseChecks, parseCorrections, slug } from "../src/vault-eval.js";

const EXAMPLE = join(import.meta.dirname, "..", "demo", "vault-eval", "example-vault");
const vault = () => {
  const d = join(mkdtempSync(join(tmpdir(), "vault-")), "v");
  cpSync(EXAMPLE, d, { recursive: true });
  return d;
};
const harness = (stdin = "") => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), readStdin: async () => stdin } };
};

describe("checks.md", () => {
  it("parses the example vault", () => {
    const checks = loadVaultChecks(EXAMPLE);
    expect(checks.map((c) => c.id)).toContain("no-guarantee-claims");
    expect(checks.filter((c) => c.severity === "critical")).toHaveLength(2);
  });

  it("rejects bad severity and duplicate ids", () => {
    const block = (id: string, sev: string) =>
      "```check\nid: " + id + "\nseverity: " + sev + "\ndate: 2026-01-01\ncorrection: x\ncriterion: Q?\n```\n";
    expect(() => parseChecks(block("a", "urgent"))).toThrow(/severity/);
    expect(() => parseChecks(block("a", "normal") + block("a", "normal"))).toThrow(/duplicate/);
  });
});

describe("corrections to checks", () => {
  it("parses bullets, paragraphs, and critical markers", () => {
    expect(parseCorrections("# t\n- [critical] No secrets.\n- Be brief.")).toEqual([
      { text: "No secrets.", severity: "critical" },
      { text: "Be brief.", severity: "normal" },
    ]);
    expect(parseCorrections("One note.\n\ncritical: Another note.")).toHaveLength(2);
  });

  it("appends checks, is idempotent, and keeps ids unique", async () => {
    const v = vault();
    const before = loadVaultChecks(v).length;
    const cs = parseCorrections("- [critical] Don't promise delivery dates.\n- Keep the tone friendly.");
    const r = await addChecks(v, cs, { date: "2026-10-01" });
    expect(r.added.map((c) => [c.id, c.severity, c.date])).toEqual([
      ["dont-promise-delivery-dates", "critical", "2026-10-01"],
      ["keep-the-tone-friendly", "normal", "2026-10-01"],
    ]);
    expect(r.added[0].criterion).toBe("Does the draft avoid this: promise delivery dates?");
    const again = await addChecks(v, cs);
    expect(again.added).toHaveLength(0);
    expect(again.skipped).toHaveLength(2);
    expect(loadVaultChecks(v)).toHaveLength(before + 2);

    // same slug, different text: id gets a suffix
    const clash = await addChecks(v, [{ text: "Keep the tone friendly!!", severity: "normal" }]);
    expect(clash.added[0].id).toMatch(/^keep-the-tone-friendly-[0-9a-f]{4}$/);
    expect(slug("Don't!")).toBe("dont");
  });
});

describe("grading", () => {
  const draft = readFileSync(join(EXAMPLE, "draft.md"), "utf8");

  it("blocks on a critical failure and flags regressions", async () => {
    const v = vault();
    const rep = await gradeDraft(loadVaultChecks(v), draft, v, { judge: new MockProvider("mock"), date: "2026-10-15" });
    expect(rep.blocked).toBe(true);
    expect(rep.criticalFailures).toEqual(["no-guarantee-claims"]);
    expect(rep.regressions.sort()).toEqual(["no-guarantee-claims", "no-hedging"]);
    expect(rep.passed).toBe(3);
    expect(rep.applicable).toBe(5);
    expect(rep.tokenCost).toBeNull();
  });

  it("is not blocked when only normal checks fail, and does not blame without a prior", async () => {
    const v = vault();
    const d = draft.replace("guaranteed", "designed");
    const rep = await gradeDraft(loadVaultChecks(v), d, v, { judge: new MockProvider("mock"), prior: null });
    expect(rep.blocked).toBe(false);
    expect(rep.results.find((r) => r.id === "no-hedging")?.verdict).toBe("fail");
    expect(rep.regressions).toEqual([]);
  });

  it("appends lessons for failures only", async () => {
    const v = vault();
    const rep = await gradeDraft(loadVaultChecks(v), draft, v, { judge: new MockProvider("mock"), date: "2026-10-15" });
    expect(appendLessons(v, rep)).toBe(2);
    const text = readFileSync(join(v, "lessons.md"), "utf8");
    expect(text).toContain("## 2026-10-15 · no-guarantee-claims (critical) · regression");
    expect(text).not.toContain("intro-is-short");
  });
});

describe("cli", () => {
  it("vault-eval exits 2 when blocked and writes reports", async () => {
    const v = vault();
    const report = join(v, "out.json");
    const h = harness();
    const code = await run(["vault-eval", "--vault", v, "--draft", join(v, "draft.md"), "--judge", "mock", "--report", report], undefined, h.io);
    expect(code).toBe(2);
    expect(h.out.join("\n")).toContain("blocked: true");
    expect(JSON.parse(readFileSync(report, "utf8")).blocked).toBe(true);
    expect(JSON.parse(readFileSync(join(v, ".last-eval.json"), "utf8")).judge).toBe("mock");
    expect(existsSync(join(v, "lessons.md"))).toBe(true);
  });

  it("vault-eval exits 0 on a clean draft (stdin)", async () => {
    const v = vault();
    const clean = "Acme Notes 4.2 adds offline search. Next step: update from Settings.";
    const h = harness(clean);
    expect(await run(["vault-eval", "--vault", v, "--judge", "mock", "--no-lessons"], undefined, h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("blocked: false");
  });

  it("vault-check add reads stdin", async () => {
    const v = vault();
    const h = harness("- [critical] Never name customers.\n");
    expect(await run(["vault-check", "add", "--vault", v, "--judge", "mock"], undefined, h.io)).toBe(0);
    expect(h.out[0]).toBe("added never-name-customers (critical)");
  });
});
