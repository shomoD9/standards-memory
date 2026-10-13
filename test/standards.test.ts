import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { createGenerator, createJudge, parseJudgement, type Runner } from "../src/providers.js";
import { Standards, loadDataset, renderTable } from "../src/standards.js";
import { tempStore } from "./helpers.js";

const setup = () => {
  const store = tempStore();
  const x = new Standards(store, createJudge("mock"));
  x.addStandard("Is the answer under 100 words?", { id: "words", scope: "a" });
  x.addStandard("Does it avoid hedging phrases?", { id: "hedge", scope: "a" });
  return { store, x };
};

const prompts = () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-"));
  const f = join(dir, "prompts.json");
  writeFileSync(f, JSON.stringify([{ id: "p1", prompt: "How do I plan a week?" }, { id: "p2", prompt: "Pick a database." }]));
  return loadDataset(f);
};

describe("providers", () => {
  it("mock judge is deterministic and keyword-based", async () => {
    const j = createJudge("mock");
    expect((await j.judge("Is it under 5 words?", "one two three")).verdict).toBe("pass");
    expect((await j.judge("Is it under 3 words?", "one two three")).verdict).toBe("fail");
    expect((await j.judge("Does it avoid hedging?", "I think so")).verdict).toBe("fail");
    expect((await j.judge("Does code ship with tests?", "A memo about lunch")).verdict).toBe("na");
    expect((await j.judge("Does code ship with tests?", "The CLI has vitest tests")).verdict).toBe("pass");
  });

  it("CLI providers shell out with the prompt on stdin and parse JSON", async () => {
    const calls: [string, string[], string][] = [];
    const runner: Runner = async (cmd, args, stdin) => {
      calls.push([cmd, args, stdin]);
      return 'Sure: {"verdict":"Fail","reason":"too long"}';
    };
    const r = await createJudge("codex", { run: runner }).judge("Q?", "text");
    expect(r).toEqual({ verdict: "fail", reason: "too long" });
    expect(calls[0][0]).toBe("codex");
    expect(calls[0][1][0]).toBe("exec");
    expect(calls[0][2]).toContain("STANDARD: Q?");
    await createGenerator("claude", "claude", { run: runner }).generate("hi");
    expect(calls[1].slice(0, 2)).toEqual(["claude", ["-p"]]);
    expect(() => parseJudgement('{"verdict":"maybe"}')).toThrow(/invalid verdict/);
    expect(() => createJudge("gpt")).toThrow(/Unknown judge/);
  });
});

describe("standards flow", () => {
  it("versions standards through the store", () => {
    const { store, x } = setup();
    expect(x.getStandard("words")).toMatchObject({ version: 1, scope: "a" });
    x.addStandard("Is the answer under 50 words?", { id: "words" });
    expect(x.getStandard("words")).toMatchObject({ version: 2, scope: "a" });
    expect(store.history("words")).toHaveLength(2);
  });

  it("scores outputs, stamping standard id, version and judge; skips current scores", async () => {
    const { store, x } = setup();
    const outputs = await x.collectOutputs(prompts(), ["claude", "codex"]);
    expect(outputs).toHaveLength(4);
    expect(store.get("out-prompt-p1-claude")?.kind).toBe("output");

    const r = await x.score(outputs);
    expect(r).toEqual({ written: 8, skipped: 0 });
    const f = store.get("score-out-prompt-p1-claude--words")!;
    expect(f.kind).toBe("score");
    expect(f.links).toEqual(["out-prompt-p1-claude", "words"]);
    expect(f.tags).toEqual(expect.arrayContaining(["standard:words", "standardVersion:1", "judge:mock", "verdict:fail"]));
    expect(JSON.parse(f.content)).toMatchObject({ standardId: "words", standardVersion: 1, judge: "mock", verdict: "fail" });

    expect(await x.score(outputs)).toEqual({ written: 0, skipped: 8 });
  });

  it("respects standard scope", async () => {
    const { x } = setup();
    x.addStandard("Does it state an explicit next action?", { id: "next", scope: "b" });
    const outputs = await x.collectOutputs(prompts(), ["codex"]);
    await x.score(outputs);
    expect(x.listScores().some((s) => s.standardId === "next")).toBe(false);
  });

  it("wrong verdict -> proposal -> accept bumps version, rescores, and is undoable", async () => {
    const { store, x } = setup();
    await x.score(await x.collectOutputs(prompts(), ["claude", "codex"]));
    const scoreId = "score-out-prompt-p1-claude--words";
    expect(x.listScores().find((s) => s.id === scoreId)?.verdict).toBe("fail");

    const p = await x.markWrong(scoreId, "up to 150 is fine");
    expect(p).toMatchObject({ status: "pending", standardId: "words", revised: "Is the answer under 150 words?" });
    expect(store.get(p.id)).toMatchObject({ kind: "proposal", links: ["words", scoreId] });
    expect(x.getStandard("words").version).toBe(1);

    const a = await x.accept(p.id);
    expect(a.standard).toMatchObject({ version: 2, question: "Is the answer under 150 words?" });
    expect(a.rescored).toBe(4);
    const after = x.listScores().filter((s) => s.standardId === "words");
    expect(after.every((s) => s.standardVersion === 2 && s.current)).toBe(true);
    expect(after.find((s) => s.id === scoreId)?.verdict).toBe("pass");
    expect(x.getProposal(p.id).status).toBe("accepted");
    expect(store.history("words")[0].message).toContain("v1 -> v2");
    await expect(x.accept(p.id)).rejects.toThrow(/already accepted/);

    store.undo(a.change);
    expect(x.getStandard("words")).toMatchObject({ version: 1, question: "Is the answer under 100 words?" });
    expect(x.getProposal(p.id).status).toBe("pending");
    expect(x.listScores().find((s) => s.id === scoreId)).toMatchObject({ standardVersion: 1, verdict: "fail", current: true });
  });

  it("reject leaves the standard unchanged and can itself be undone", async () => {
    const { store, x } = setup();
    await x.score(await x.collectOutputs(prompts(), ["claude"]));
    const p = await x.markWrong("score-out-prompt-p1-claude--hedge", "fine here");
    const { change } = x.reject(p.id);
    expect(x.getProposal(p.id).status).toBe("rejected");
    expect(x.getStandard("hedge").version).toBe(1);
    await expect(x.accept(p.id)).rejects.toThrow(/already rejected/);
    store.undo(change);
    expect(x.getProposal(p.id).status).toBe("pending");
  });

  it("renders a table with stale markers", async () => {
    const { x } = setup();
    await x.score(await x.collectOutputs(prompts(), ["claude", "codex"]));
    x.addStandard("Is the answer under 200 words?", { id: "words" });
    const t = renderTable(x.listScores());
    expect(t).toContain("prompt-p1-claude");
    expect(t).toContain("FAIL v1*");
    expect(t).toContain("stale");
  });

  it("loads the bundled demo datasets", () => {
    expect(loadDataset(join(__dirname, "../demo/prompts.json"))).toHaveLength(3);
    expect(loadDataset(join(__dirname, "../demo/sample-docs"))).toHaveLength(4);
  });
});

describe("cli: standards", () => {
  it("runs the subcommands end to end with the mock judge", async () => {
    const store = tempStore();
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(`ERR ${s}`), readStdin: async () => "" };
    const cli = async (...a: string[]) => {
      out.length = 0;
      expect(await run(a, store, io)).toBe(0);
      return out.join("\n");
    };
    const ds = join(__dirname, "../demo/prompts.json");
    expect(await cli("standard", "add", "Is the answer under 100 words?", "--id", "words")).toContain("words v1");
    expect(await cli("standard", "list")).toContain("words\tv1");
    expect(await cli("score", "--judge", "mock", "--models", "claude,codex", "--dataset", ds)).toContain("6 written");
    expect(await cli("scores")).toContain("fail");
    expect(await cli("scores", "--table")).toContain("prompt-onboarding-claude");

    const prop = (await cli("verdict", "wrong", "score-out-prompt-onboarding-claude--words", "--note", "150 ok")).match(/proposal (\S+)/)![1];
    const acc = await cli("proposal", "accept", prop);
    expect(acc).toContain("words now v2");
    expect(await cli("scores", "--standard", "words")).toContain("words@v2");
    await cli("undo", acc.match(/change (\w+)/)![1]);
    expect(await cli("proposal", "list")).toContain("pending");
    expect(await cli("standard", "list")).toContain("words\tv1");
  });
});
