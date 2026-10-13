import { execFile } from "node:child_process";

export type Verdict = "pass" | "fail" | "na";

export interface Judgement {
  verdict: Verdict;
  reason: string;
}

export interface Generator {
  readonly name: string;
  generate(prompt: string): Promise<string>;
}

export interface Judge {
  readonly name: string;
  /** Answer a yes/no standard about one output. "na" means the standard doesn't apply. */
  judge(question: string, output: string): Promise<Judgement>;
  /** Draft a revised wording of the standard after a human called a verdict wrong. */
  reviseStandard(input: ReviseInput): Promise<string>;
}

export interface ReviseInput {
  question: string;
  output: string;
  verdict: Verdict;
  reason: string;
  note?: string;
}

/** Runs a CLI with the prompt on stdin and returns stdout. Injectable for tests. */
export type Runner = (cmd: string, args: string[], stdin: string) => Promise<string>;

export const execRunner: Runner = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${stderr?.trim() || err.message}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(stdin);
  });

const CLI_ARGS: Record<string, [string, string[]]> = {
  claude: ["claude", ["-p"]],
  codex: ["codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "-"]],
};

export function judgePrompt(question: string, output: string): string {
  return [
    "You are a strict evaluator. Answer the yes/no standard about the output below.",
    'Reply with ONLY a JSON object: {"verdict":"pass"|"fail"|"na","reason":"<one sentence>"}.',
    '"pass" = the answer to the standard is yes; "fail" = no; "na" = the standard does not apply to this output.',
    "",
    `STANDARD: ${question}`,
    "",
    "OUTPUT:",
    "<<<",
    output,
    ">>>",
  ].join("\n");
}

export function revisePrompt(r: ReviseInput): string {
  return [
    "A yes/no quality standard produced a verdict that a human says is wrong.",
    "Rewrite the standard so it is a single yes/no question that would give the correct verdict here",
    "while staying faithful to its intent. Reply with ONLY the revised question.",
    "",
    `STANDARD: ${r.question}`,
    `VERDICT GIVEN: ${r.verdict} (${r.reason})`,
    `HUMAN NOTE: ${r.note || "(none)"}`,
    "",
    "OUTPUT:",
    "<<<",
    r.output,
    ">>>",
  ].join("\n");
}

export function parseJudgement(text: string): Judgement {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error(`Judge returned no JSON: ${text.slice(0, 120)}`);
  const j = JSON.parse(m[0]) as { verdict?: string; reason?: string };
  const verdict = String(j.verdict ?? "").toLowerCase();
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "na") {
    throw new Error(`Judge returned invalid verdict: ${j.verdict}`);
  }
  return { verdict, reason: String(j.reason ?? "").trim() };
}

class CliProvider implements Generator, Judge {
  constructor(
    readonly name: string,
    private run: Runner,
  ) {
    if (!CLI_ARGS[name]) throw new Error(`No CLI for provider ${name}`);
  }

  private ask(prompt: string): Promise<string> {
    const [cmd, args] = CLI_ARGS[this.name];
    return this.run(cmd, args, prompt);
  }

  generate(prompt: string): Promise<string> {
    return this.ask(prompt);
  }

  async judge(question: string, output: string): Promise<Judgement> {
    return parseJudgement(await this.ask(judgePrompt(question, output)));
  }

  async reviseStandard(r: ReviseInput): Promise<string> {
    const text = (await this.ask(revisePrompt(r))).split("\n").map((l) => l.trim()).find(Boolean);
    if (!text) throw new Error("Judge returned an empty revision");
    return text.replace(/^STANDARD:\s*/i, "");
  }
}

const HEDGES =
  /\b(i think|i believe|it depends|might|maybe|perhaps|possibly|probably|arguably|could be|seems? to|somewhat|sort of|kind of)\b/i;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Deterministic keyword-based provider for tests and offline runs. */
export class MockProvider implements Generator, Judge {
  readonly name: string;

  /** `persona` shapes generated text so different "models" differ: claude is wordy and hedgy, others terse. */
  constructor(private persona = "mock") {
    this.name = persona;
  }

  async generate(prompt: string): Promise<string> {
    const topic = prompt.replace(/[?.!]+$/, "").trim();
    if (this.persona === "claude") {
      const filler =
        "There are several angles worth weighing here, including context, trade-offs, and who the audience is, " +
        "and each of them shifts the practical advice you would want to follow in a real project.";
      return `I think the short answer to "${topic}" is that it depends. ${filler} Perhaps the most useful starting point ` +
        `is to write down what you already know, and then maybe compare two or three options. ${filler} ` +
        "In practice, it could be that a small experiment tells you more than further analysis.";
    }
    return `Short answer on "${topic}": pick one option, try it for a day, and keep what works.`;
  }

  async judge(question: string, output: string): Promise<Judgement> {
    const q = question.toLowerCase();
    const under = /under (\d+) words/.exec(q);
    if (under) {
      const n = Number(under[1]);
      const w = wordCount(output);
      return w < n
        ? { verdict: "pass", reason: `${w} words, under ${n}.` }
        : { verdict: "fail", reason: `${w} words, not under ${n}.` };
    }
    if (q.includes("hedg")) {
      const m = HEDGES.exec(output);
      return m
        ? { verdict: "fail", reason: `Hedging phrase "${m[0]}".` }
        : { verdict: "pass", reason: "No hedging phrases found." };
    }
    if (q.includes("verified source") || q.includes("cite")) {
      const bad = /\b(unverified|unsupported|citation needed|reportedly|allegedly)\b|not supported/i.exec(output);
      if (bad) return { verdict: "fail", reason: `Contains "${bad[0]}".` };
      if (!/\[S\d+\]|https?:\/\//.test(output)) return { verdict: "na", reason: "No sources cited or needed." };
      return { verdict: "pass", reason: "Sources cited, none flagged unverified." };
    }
    if (q.includes("test")) {
      if (!/```|\bcode\b|\brepo\b|\bcli\b|\bscript\b|\bprototype\b/i.test(output)) {
        return { verdict: "na", reason: "No code involved." };
      }
      return /\btests?\b|vitest|acceptance/i.test(output)
        ? { verdict: "pass", reason: "Mentions tests or acceptance criteria." }
        : { verdict: "fail", reason: "Code involved but no tests mentioned." };
    }
    if (q.includes("next action") || q.includes("decision") || q.includes("next step")) {
      return /next step|next action|decision|decide|approv|needs owner/i.test(output)
        ? { verdict: "pass", reason: "States a next action or decision." }
        : { verdict: "fail", reason: "No explicit next action or decision." };
    }
    const terms = q.replace(/[^a-z ]/g, " ").split(/\s+/).filter((t) => t.length > 5);
    const hit = terms.find((t) => output.toLowerCase().includes(t));
    return hit
      ? { verdict: "pass", reason: `Mentions "${hit}".` }
      : { verdict: "fail", reason: "No keyword from the standard appears." };
  }

  async reviseStandard(r: ReviseInput): Promise<string> {
    const base = r.question.replace(/\?\s*$/, "");
    const under = /under (\d+) words/i.exec(base);
    if (under) {
      const noted = r.note ? /\d+/.exec(r.note) : null;
      const next = noted ? Number(noted[0]) : Math.ceil((wordCount(r.output) + 1) / 50) * 50;
      return `${base.replace(under[0], `under ${next} words`)}?`;
    }
    const why = r.note?.trim() || `the verdict "${r.verdict}" was judged wrong`;
    return `${base}, taking into account that ${why.replace(/[.\s]+$/, "")}?`;
  }
}

export interface ProviderOptions {
  run?: Runner;
}

export const PROVIDER_NAMES = ["claude", "codex", "mock"] as const;

/** Judge by name: claude | codex | mock. Defaults to MEM_JUDGE, then mock. */
export function createJudge(name = process.env.MEM_JUDGE || "mock", o: ProviderOptions = {}): Judge {
  if (name === "mock") return new MockProvider("mock");
  if (name === "claude" || name === "codex") return new CliProvider(name, o.run ?? execRunner);
  throw new Error(`Unknown judge "${name}" (use ${PROVIDER_NAMES.join(", ")})`);
}

/**
 * Generator for a model name. When the judge is mock the run is offline, so models
 * are simulated by mock personas instead of shelling out.
 */
export function createGenerator(model: string, judgeName: string, o: ProviderOptions = {}): Generator {
  if (judgeName === "mock" || model === "mock") return new MockProvider(model);
  if (model === "claude" || model === "codex") return new CliProvider(model, o.run ?? execRunner);
  throw new Error(`Unknown model "${model}" (use ${PROVIDER_NAMES.join(", ")})`);
}
