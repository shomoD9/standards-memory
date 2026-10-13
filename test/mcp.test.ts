import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHandlers, createServer } from "../src/mcp.js";
import { tempStore } from "./helpers.js";

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("mcp handlers", () => {
  it("remember / recall / history", () => {
    const h = createHandlers(tempStore());
    const r = parse(h.remember({ id: "m", content: "hello world", author: "codex" }));
    expect(r.fact.id).toBe("m");
    expect(parse(h.recall({ query: "HELLO" }))[0].fact.id).toBe("m");
    expect(parse(h.history({ id: "m" }))[0].change).toBe(r.change);
  });

  it("reports errors as isError", () => {
    const res = createHandlers(tempStore()).remember({ id: "../x", content: "y" });
    expect(res.isError).toBe(true);
  });

  it("works end-to-end over the protocol", async () => {
    const server = createServer(tempStore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["history", "recall", "remember"]);
    await client.callTool({ name: "remember", arguments: { id: "p", content: "proto fact" } });
    const res = (await client.callTool({ name: "recall", arguments: { query: "proto" } })) as { content: { text: string }[] };
    expect(parse(res)[0].fact.id).toBe("p");
  });
});
