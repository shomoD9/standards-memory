import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { tempStore } from "./helpers.js";

function harness(stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), readStdin: async () => stdin };
  return { out, err, io };
}

describe("cli", () => {
  it("remember (arg + stdin), recall, show, list, history, forget, undo", async () => {
    const store = tempStore();
    let h = harness();
    expect(await run(["remember", "MRR excludes one-offs", "--id", "mrr", "--author", "claude", "--source", "slack", "--link", "a", "--link", "b"], store, h.io)).toBe(0);
    expect(h.out[0]).toMatch(/^created mrr \(v1\) change [0-9a-f]{40}$/);
    expect(store.get("mrr")?.links).toEqual(["a", "b"]);

    h = harness("from stdin\nline two\n");
    await run(["remember", "--id", "s"], store, h.io);
    expect(store.get("s")?.content).toBe("from stdin\nline two");

    h = harness();
    await run(["recall", "one-offs"], store, h.io);
    expect(h.out[0]).toContain("mrr");

    h = harness();
    await run(["show", "mrr"], store, h.io);
    expect(JSON.parse(h.out[0]).author).toBe("claude");

    h = harness();
    await run(["list"], store, h.io);
    expect(h.out).toHaveLength(2);

    h = harness();
    await run(["forget", "mrr"], store, h.io);
    const change = h.out[0].split(" ").pop()!;
    expect(store.get("mrr")).toBeNull();

    h = harness();
    await run(["history", "mrr"], store, h.io);
    expect(h.out).toHaveLength(2);

    h = harness();
    expect(await run(["undo", change], store, h.io)).toBe(0);
    expect(store.get("mrr")).not.toBeNull();
  });

  it("returns nonzero with message on errors", async () => {
    const h = harness();
    expect(await run(["show", "missing"], tempStore(), h.io)).toBe(1);
    expect(h.err[0]).toContain("No such fact");
    expect(await run(["remember"], tempStore(), harness("  ").io)).toBe(1);
  });
});
