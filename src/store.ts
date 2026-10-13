import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";

export interface Fact {
  id: string;
  author: string;
  timestamp: string;
  source: string;
  links: string[];
  tags?: string[];
  kind?: string;
  version?: number;
  content: string;
}

export interface RememberInput {
  id?: string;
  content: string;
  author?: string;
  source?: string;
  links?: string[];
  tags?: string[];
  kind?: string;
}

export interface RememberResult {
  fact: Fact;
  change: string;
  created: boolean;
}

export interface HistoryEntry {
  change: string;
  timestamp: string;
  author: string;
  message: string;
  /** Fact as of this commit; null when the commit deleted it. */
  fact: Fact | null;
}

export interface RecallHit {
  fact: Fact;
  score: number;
}

export interface ChangeEntry {
  change: string;
  timestamp: string;
  author: string;
  message: string;
}

export interface Graph {
  nodes: { id: string; exists: boolean }[];
  edges: { from: string; to: string }[];
  backlinks: Record<string, string[]>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHANGE_RE = /^[0-9a-f]{4,64}$/i;

export function defaultMemDir(): string {
  return resolve(process.env.MEM_DIR ?? "./.mem");
}

export function validateId(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid fact id "${id}" (use letters, digits, '.', '_', '-')`);
  return id;
}

function serialize(f: Fact): string {
  const { content, ...meta } = f;
  const ordered: Record<string, unknown> = {
    id: meta.id,
    author: meta.author,
    timestamp: meta.timestamp,
    source: meta.source,
    links: meta.links,
  };
  if (meta.tags) ordered.tags = meta.tags;
  if (meta.kind) ordered.kind = meta.kind;
  if (meta.version !== undefined) ordered.version = meta.version;
  return `---\n${stringify(ordered)}---\n${content}\n`;
}

function parseFact(text: string): Fact {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("Fact file has no frontmatter");
  const meta = parse(m[1]) as Record<string, unknown>;
  const fact: Fact = {
    id: String(meta.id),
    author: String(meta.author ?? ""),
    timestamp: String(meta.timestamp ?? ""),
    source: String(meta.source ?? ""),
    links: Array.isArray(meta.links) ? meta.links.map(String) : [],
    content: m[2].replace(/\n$/, ""),
  };
  if (Array.isArray(meta.tags)) fact.tags = meta.tags.map(String);
  if (meta.kind !== undefined) fact.kind = String(meta.kind);
  if (meta.version !== undefined) fact.version = Number(meta.version);
  return fact;
}

export class Store {
  readonly dir: string;

  constructor(dir: string = defaultMemDir()) {
    this.dir = resolve(dir);
    mkdirSync(join(this.dir, "facts"), { recursive: true });
    if (!existsSync(join(this.dir, ".git"))) {
      this.git(["init", "-q"]);
    }
  }

  private git(args: string[], env: Record<string, string> = {}): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "mem",
        GIT_AUTHOR_EMAIL: "mem@localhost",
        GIT_COMMITTER_NAME: "mem",
        GIT_COMMITTER_EMAIL: "mem@localhost",
        ...env,
      },
    });
  }

  private path(id: string): string {
    return `facts/${validateId(id)}.md`;
  }

  private commit(paths: string[], message: string, author: string): string {
    this.git(["commit", "-q", "-m", message, "--only", "--", ...paths], {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.replace(/[^A-Za-z0-9._-]/g, "_")}@mem.local`,
    });
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  get(id: string): Fact | null {
    const file = join(this.dir, this.path(id));
    if (!existsSync(file)) return null;
    return parseFact(readFileSync(file, "utf8"));
  }

  remember(input: RememberInput): RememberResult {
    const id = input.id ?? `fact-${randomBytes(4).toString("hex")}`;
    const existing = this.get(id);
    const fact: Fact = {
      id,
      author: input.author ?? existing?.author ?? "unknown",
      timestamp: new Date().toISOString(),
      source: input.source ?? existing?.source ?? "",
      links: input.links ?? existing?.links ?? [],
      content: input.content,
      version: existing ? (existing.version ?? 1) + 1 : 1,
    };
    const tags = input.tags ?? existing?.tags;
    const kind = input.kind ?? existing?.kind;
    if (tags) fact.tags = tags;
    if (kind) fact.kind = kind;
    for (const l of fact.links) validateId(l);

    const rel = this.path(id);
    writeFileSync(join(this.dir, rel), serialize(fact), "utf8");
    this.git(["add", "--", rel]);
    const change = this.commit(
      [rel],
      `${existing ? "update" : "remember"} ${id} (v${fact.version})`,
      fact.author,
    );
    return { fact, change, created: !existing };
  }

  list(): Fact[] {
    const dir = join(this.dir, "facts");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => parseFact(readFileSync(join(dir, f), "utf8")));
  }

  recall(query: string): RecallHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: RecallHit[] = [];
    for (const fact of this.list()) {
      const hay = [fact.id, fact.kind ?? "", (fact.tags ?? []).join(" "), fact.source, fact.content]
        .join("\n")
        .toLowerCase();
      let score = 0;
      let all = true;
      for (const t of terms) {
        const n = hay.split(t).length - 1;
        if (n === 0) {
          all = false;
          break;
        }
        score += n;
      }
      if (all) hits.push({ fact, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id));
  }

  history(id: string): HistoryEntry[] {
    const rel = this.path(id);
    if (!this.log(1).length) return [];
    const out = this.git(["log", "--format=%H%x1f%aI%x1f%an%x1f%s%x1e", "--", rel]);
    const entries: HistoryEntry[] = [];
    for (const rec of out.split("\x1e")) {
      const r = rec.trim();
      if (!r) continue;
      const [change, timestamp, author, message] = r.split("\x1f");
      let fact: Fact | null = null;
      try {
        fact = parseFact(this.git(["show", `${change}:${rel}`]));
      } catch {
        fact = null; // file absent at this commit (deletion)
      }
      entries.push({ change, timestamp, author, message, fact });
    }
    return entries;
  }

  /** Most recent commits, newest first (including undo commits). */
  log(limit = 50): ChangeEntry[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid log limit");
    try {
      this.git(["rev-parse", "--verify", "HEAD"]);
    } catch {
      return [];
    }
    return this.git(["log", `-${limit}`, "--format=%H%x1f%aI%x1f%an%x1f%s%x1e"])
      .split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
        const [change, timestamp, author, message] = r.split("\x1f");
        return { change, timestamp, author, message };
      });
  }

  forget(id: string, author = "unknown"): string {
    const rel = this.path(id);
    if (!existsSync(join(this.dir, rel))) throw new Error(`No such fact: ${id}`);
    this.git(["rm", "-q", "--", rel]);
    return this.commit([rel], `forget ${id}`, author);
  }

  undo(changeId: string): string {
    if (!CHANGE_RE.test(changeId)) throw new Error(`Invalid change id "${changeId}"`);
    try {
      this.git(["revert", "--no-edit", changeId]);
    } catch (e) {
      try {
        this.git(["revert", "--abort"]);
      } catch {
        /* nothing to abort */
      }
      throw new Error(`Cannot undo ${changeId}: ${(e as { stderr?: string }).stderr?.trim() || e}`);
    }
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  /** Outgoing links and backlinks for one fact. */
  links(id: string): { outgoing: string[]; incoming: string[] } {
    validateId(id);
    const facts = this.list();
    return {
      outgoing: facts.find((f) => f.id === id)?.links ?? [],
      incoming: facts.filter((f) => f.links.includes(id)).map((f) => f.id),
    };
  }

  graph(): Graph {
    const facts = this.list();
    const existing = new Set(facts.map((f) => f.id));
    const ids = new Set(existing);
    const edges: Graph["edges"] = [];
    const backlinks: Record<string, string[]> = {};
    for (const f of facts) {
      for (const to of f.links) {
        ids.add(to);
        edges.push({ from: f.id, to });
        (backlinks[to] ??= []).push(f.id);
      }
    }
    return {
      nodes: [...ids].sort().map((id) => ({ id, exists: existing.has(id) })),
      edges,
      backlinks,
    };
  }
}
