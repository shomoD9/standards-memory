import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";

describe("store", () => {
  it("remembers, gets, and writes frontmatter", () => {
    const s = tempStore();
    const r = s.remember({ id: "mrr", content: "MRR is X", author: "a", source: "doc", links: ["b"] });
    expect(r.created).toBe(true);
    expect(r.change).toMatch(/^[0-9a-f]{40}$/);
    expect(s.get("mrr")).toMatchObject({ id: "mrr", author: "a", version: 1, links: ["b"], content: "MRR is X" });
    const raw = readFileSync(join(s.dir, "facts/mrr.md"), "utf8");
    expect(raw.startsWith("---\nid: mrr\n")).toBe(true);
  });

  it("update bumps version and preserves unspecified fields", () => {
    const s = tempStore();
    s.remember({ id: "x", content: "one", author: "a", tags: ["t"] });
    const r = s.remember({ id: "x", content: "two" });
    expect(r.created).toBe(false);
    expect(r.fact).toMatchObject({ version: 2, author: "a", tags: ["t"], content: "two" });
  });

  it("recall requires all terms, case-insensitive, ranked", () => {
    const s = tempStore();
    s.remember({ id: "a", content: "Revenue revenue revenue monthly" });
    s.remember({ id: "b", content: "revenue monthly" });
    s.remember({ id: "c", content: "monthly only" });
    expect(s.recall("REVENUE monthly").map((h) => h.fact.id)).toEqual(["a", "b"]);
    expect(s.recall("nothing")).toEqual([]);
  });

  it("history lists commits with contents, including deletion", () => {
    const s = tempStore();
    s.remember({ id: "h", content: "v1" });
    s.remember({ id: "h", content: "v2" });
    s.forget("h");
    const h = s.history("h");
    expect(h).toHaveLength(3);
    expect(h[0].fact).toBeNull();
    expect(h[1].fact?.content).toBe("v2");
    expect(h[2].fact?.content).toBe("v1");
  });

  it("forget deletes and undo restores", () => {
    const s = tempStore();
    s.remember({ id: "f", content: "keep me" });
    const del = s.forget("f");
    expect(s.get("f")).toBeNull();
    s.undo(del);
    expect(s.get("f")?.content).toBe("keep me");
    expect(() => s.forget("nope")).toThrow();
  });

  it("undo reverts an update", () => {
    const s = tempStore();
    s.remember({ id: "u", content: "old" });
    const { change } = s.remember({ id: "u", content: "new" });
    s.undo(change);
    expect(s.get("u")?.content).toBe("old");
  });

  it("rejects bad ids and change ids", () => {
    const s = tempStore();
    expect(() => s.remember({ id: "../evil", content: "x" })).toThrow();
    expect(() => s.undo("--abort")).toThrow();
  });

  it("builds graph with backlinks and dangling nodes", () => {
    const s = tempStore();
    s.remember({ id: "a", content: "A", links: ["b", "ghost"] });
    s.remember({ id: "b", content: "B", links: ["a"] });
    const g = s.graph();
    expect(g.edges).toHaveLength(3);
    expect(g.nodes.find((n) => n.id === "ghost")?.exists).toBe(false);
    expect(g.backlinks.a).toEqual(["b"]);
    expect(s.links("b")).toEqual({ outgoing: ["a"], incoming: ["a"] });
    expect(s.list().map((f) => f.id)).toEqual(["a", "b"]);
  });
});
