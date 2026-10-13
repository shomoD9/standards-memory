import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { rmSync } from "node:fs";
import { startWeb } from "../src/web.js";
import { tempStore } from "./helpers.js";
import type { Store } from "../src/store.js";

let server: Server;
let store: Store;
let base: string;
beforeEach(async () => {
  store = tempStore();
  server = await startWeb(store, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  rmSync(store.dir, { recursive: true, force: true });
});
const request = (path: string, options?: RequestInit) => fetch(base + path, options);
const get = async (path: string) => (await request(path)).json();

describe("web API", () => {
  it("serves the page and an empty store", async () => {
    const page = await request("/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<svg");
    expect(await get("/api/facts")).toEqual([]);
    expect(await get("/api/log")).toEqual([]);
    expect(await get("/api/history/missing")).toEqual([]);
    expect(await get("/api/graph")).toEqual({ nodes: [], edges: [], backlinks: {} });
  });

  it("lists, searches, gets details and backlinks, history, graph and commits", async () => {
    store.remember({ id: "a", content: "First apple", links: ["b", "ghost"] });
    store.remember({ id: "b", content: "Banana" });
    const update = store.remember({ id: "a", content: "Second apple" });
    expect((await get("/api/facts")).map((f: { id: string }) => f.id)).toEqual(["a", "b"]);
    expect((await get("/api/facts?q=APPLE")).map((f: { id: string }) => f.id)).toEqual(["a"]);
    expect(await get("/api/facts/b")).toMatchObject({ content: "Banana", backlinks: ["a"] });
    expect(await get("/api/facts/a")).toMatchObject({ links: ["b", "ghost"] });
    const history = await get("/api/history/a");
    expect(history.map((h: { fact: { content: string } }) => h.fact.content)).toEqual(["Second apple", "First apple"]);
    const graph = await get("/api/graph");
    expect(graph.nodes).toContainEqual({ id: "ghost", exists: false });
    expect(graph.edges).toContainEqual({ from: "a", to: "b" });
    expect((await get("/api/log"))[0]).toMatchObject({ change: update.change, message: "update a (v2)" });
  });

  it("undoes an update and exposes the resulting state and history", async () => {
    store.remember({ id: "a", content: "Old" });
    const { change } = store.remember({ id: "a", content: "New" });
    const response = await request(`/api/undo/${change}`, { method: "POST" });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.change).toMatch(/^[0-9a-f]{40}$/);
    expect(await get("/api/facts/a")).toMatchObject({ content: "Old" });
    expect((await get("/api/log"))[0].change).toBe(result.change);
    expect(await get("/api/history/a")).toHaveLength(3);
    const deletion = store.forget("a");
    expect((await request("/api/facts/a")).status).toBe(404);
    expect((await get("/api/history/a"))[0].fact).toBeNull();
    expect((await request(`/api/undo/${deletion}`, { method: "POST" })).status).toBe(200);
  });

  it("handles missing routes, invalid input, wrong methods and undo failures", async () => {
    store.remember({ id: "a", content: "A" });
    expect((await request("/missing")).status).toBe(404);
    expect((await request("/api/facts/missing")).status).toBe(404);
    expect(await get("/api/history/missing")).toEqual([]);
    expect((await request("/api/facts/bad%2Fid")).status).toBe(400);
    expect((await request("/api/facts/%ZZ")).status).toBe(400);
    expect((await request("/api/facts", { method: "POST" })).status).toBe(405);
    expect((await request("/api/undo/deadbeef")).headers.get("allow")).toBe("POST");
    expect((await request("/api/undo/nope", { method: "POST" })).status).toBe(400);
    expect((await request("/api/undo/deadbeef", { method: "POST" })).status).toBe(409);
    expect((await request("/api/undo/deadbeef", { method: "POST", headers: { Origin: "https://example.com" } })).status).toBe(403);
  });

  it("rejects invalid ports", async () => {
    await expect(startWeb(store, -1)).rejects.toThrow("Invalid port");
    await expect(startWeb(store, 65536)).rejects.toThrow("Invalid port");
  });
});
