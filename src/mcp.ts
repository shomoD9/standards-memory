import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "./store.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

function guard<A>(fn: (a: A) => unknown): (a: A) => ToolResult {
  return (a) => {
    try {
      return ok(fn(a));
    } catch (e) {
      return fail(e);
    }
  };
}

/** Plain tool handlers, independent of the MCP transport (used by tests). */
export function createHandlers(store: Store) {
  return {
    remember: guard(
      (a: { content: string; id?: string; author?: string; source?: string; links?: string[]; tags?: string[]; kind?: string }) =>
        store.remember(a),
    ),
    recall: guard((a: { query: string }) => store.recall(a.query)),
    history: guard((a: { id: string }) => store.history(a.id)),
  };
}

export function createServer(store: Store): McpServer {
  const server = new McpServer({ name: "standards-memory", version: "0.1.0" });
  const h = createHandlers(store);
  server.registerTool(
    "remember",
    {
      description: "Create or update a fact (by id). Every call is a git commit; the returned `change` id can be undone.",
      inputSchema: {
        content: z.string().describe("Fact body (markdown)"),
        id: z.string().optional().describe("Fact id; omit to create a new one, reuse to update"),
        author: z.string().optional().describe("Who is writing this fact"),
        source: z.string().optional().describe("Where the fact came from"),
        links: z.array(z.string()).optional().describe("Ids of related facts"),
        tags: z.array(z.string()).optional(),
        kind: z.string().optional(),
      },
    },
    async (a) => h.remember(a),
  );
  server.registerTool(
    "recall",
    {
      description: "Keyword search over facts (case-insensitive, all terms must match), ranked by hits.",
      inputSchema: { query: z.string() },
    },
    async (a) => h.recall(a),
  );
  server.registerTool(
    "history",
    {
      description: "Change history of a fact, with its contents at each commit.",
      inputSchema: { id: z.string() },
    },
    async (a) => h.history(a),
  );
  return server;
}

export async function startMcp(store: Store = new Store()): Promise<void> {
  await createServer(store).connect(new StdioServerTransport());
}
