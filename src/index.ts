/**
 * Pro Prompter — a free, open MCP server that turns a rough request into a
 * FAANG-grade engineered prompt and has the host AI execute it, using ZERO
 * extra API credits.
 *
 * How the "zero credits" trick works:
 *   An MCP server on Claude/ChatGPT cannot call an LLM itself (sampling is
 *   unsupported in 2026), and it can't intercept your message before the AI
 *   reads it. So Pro Prompter doesn't run any AI of its own. Instead, each tool
 *   returns a world-class *meta-prompt* (pure text, instant, free). The host
 *   model — the Claude/ChatGPT you're already talking to — reads that text and
 *   does the rewriting + answering in the SAME turn. No API key, no extra bill.
 *
 * Interfaces:
 *   Tool  pro_prompt     -> engineer the prompt AND execute it (refine + run)
 *   Tool  refine_prompt  -> return ONLY the engineered prompt (to copy/reuse)
 *   Tool  recall_prompts -> list this session's recent requests (memory)
 *   Tool  clear_memory   -> wipe this session's memory
 *   Prompt pro_prompt    -> Claude-only slash-command version of refine + run
 *
 * Endpoints once deployed:
 *   GET  /      -> landing page
 *   POST /mcp   -> Streamable HTTP (use this URL in Claude & ChatGPT)
 *        /sse   -> legacy SSE transport
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// The FAANG-grade rubric, distilled from Anthropic + OpenAI official guidance.
// This is the "intelligence" Pro Prompter injects; the host model applies it.
// ---------------------------------------------------------------------------
const RUBRIC = `RUBRIC — include only the parts that add signal; add structure, never padding:
• Role — one line, only if it shifts expertise or tone.
• Context + why — the minimum background PLUS the motivation, stated once (the model generalizes from the "why").
• Task — one precise, action-verb objective with a clear definition of "done".
• Steps — numbered only when order or completeness matters.
• Constraints — phrased positively ("do X", not "don't do Y"), with zero contradictions.
• Output format — the exact structure/shape expected back (name the tags or schema).
• Examples — none by default; add 1–3 diverse, relevant ones only if format or edge-cases are hard to convey in words.
• Success criteria — the quality bar plus a final self-check.`;

const NON_NEGOTIABLES = `NON-NEGOTIABLES:
• Preserve every detail, constraint, and {variable} from the raw request verbatim — never drop or invent requirements.
• Keep it information-dense: shorter is better whenever fidelity holds. No filler, no ALL-CAPS "CRITICAL/MUST" over-prompting.`;

type Analysis = {
  taskType: string;
  taskHint: string;
  complexityNote: string;
};

function analyze(request: string): Analysis {
  const t = request.toLowerCase();
  const wordCount = (request.match(/\S+/g) ?? []).length;

  let taskType = "general";
  let taskHint = "";
  if (/\b(code|function|bug|api|script|program|regex|sql|python|javascript|typescript|react|component|refactor|debug|algorithm)\b/.test(t)) {
    taskType = "code";
    taskHint = "TASK-SPECIFIC: specify language/framework, inputs & outputs, constraints, edge cases, and that the code must be complete and runnable.";
  } else if (/\b(write|essay|blog|email|article|story|poem|copy|caption|tweet|post|letter|script|newsletter)\b/.test(t)) {
    taskType = "writing";
    taskHint = "TASK-SPECIFIC: specify audience, tone, length, format, and the piece's purpose.";
  } else if (/\b(design|landing page|website|ui|ux|logo|layout|mockup|brand|figma)\b/.test(t)) {
    taskType = "design";
    taskHint = "TASK-SPECIFIC: specify audience, style/brand, required sections, responsiveness, and the deliverable format.";
  } else if (/\b(analyz|analyse|compare|evaluate|research|summar|assess|pros and cons|explain|review)\b/.test(t)) {
    taskType = "analysis";
    taskHint = "TASK-SPECIFIC: specify the analytical framework, the dimensions to cover, evidence expectations, and the output structure.";
  } else if (/\b(data|table|csv|chart|graph|dataset|spreadsheet|plot|metric)\b/.test(t)) {
    taskType = "data";
    taskHint = "TASK-SPECIFIC: specify the input shape, the exact computation/transformation, and the output format.";
  }

  const complex = wordCount > 12 || /\b(detailed|comprehensive|production|step by step|in depth|thorough|complex|architecture|end.to.end)\b/.test(t);
  const complexityNote = complex
    ? "This is a non-trivial request — apply the full rubric wherever it adds value."
    : "This looks like a simple request — keep the engineered prompt minimal (role + clear task + output format). Do NOT over-engineer it.";

  return { taskType, taskHint, complexityNote };
}

function reasoningDirective(modelClass: string): string {
  if (modelClass === "chat") {
    return 'REASONING: if the task needs multi-step logic/math, instruct the model to reason inside <thinking> tags and give the final answer in <answer> tags.';
  }
  // auto + reasoning: modern hosts (Claude Opus, GPT-5) reason internally.
  return 'REASONING: treat the executing model as a reasoning model — do NOT add "think step by step"; give it the goal, constraints, and success criteria and let it reason internally.';
}

function memoryBlock(history: string[]): string {
  if (history.length === 0) return "";
  const lines = history.map((h) => `• ${h.length > 160 ? h.slice(0, 157) + "…" : h}`).join("\n");
  return `SESSION CONTEXT — earlier requests in this session you may build on (most recent first):\n${lines}\n\n`;
}

function buildRefineAndRun(request: string, modelClass: string, history: string[]): string {
  const { taskHint, complexityNote } = analyze(request);
  return `🧠 PRO PROMPTER — engineer, then execute.

You are an elite, FAANG-level prompt engineer AND the executor. Transform the RAW REQUEST below into ONE optimally-engineered prompt, then carry it out fully.

${RUBRIC}
${taskHint ? taskHint + "\n" : ""}${reasoningDirective(modelClass)}

${NON_NEGOTIABLES}
• ${complexityNote}

Respond in EXACTLY this shape:

**🎯 Engineered prompt**
<the rewritten prompt>

**✅ Result**
<now execute that engineered prompt in full, to the highest standard — no confirmation, no preamble>

${memoryBlock(history)}RAW REQUEST
<<<
${request}
>>>`;
}

function buildRefineOnly(request: string, modelClass: string): string {
  const { taskHint, complexityNote } = analyze(request);
  return `🧠 PRO PROMPTER — engineer only (do not execute).

You are an elite, FAANG-level prompt engineer. Rewrite the RAW REQUEST below into ONE optimally-engineered prompt.

${RUBRIC}
${taskHint ? taskHint + "\n" : ""}${reasoningDirective(modelClass)}

${NON_NEGOTIABLES}
• ${complexityNote}

Output ONLY the engineered prompt — ready to copy and reuse. Do NOT execute it, and add no commentary before or after.

RAW REQUEST
<<<
${request}
>>>`;
}

const MODEL_CLASS = z
  .enum(["auto", "reasoning", "chat"])
  .optional()
  .describe('Executing model class. "reasoning" (Claude Opus / GPT-5 / o-series) skips chain-of-thought; "chat" adds it. Default "auto" = reasoning.');

export class ProPrompter extends McpAgent {
  server = new McpServer({
    name: "Pro Prompter",
    version: "1.0.0",
  });

  private ensureTable() {
    this.sql`CREATE TABLE IF NOT EXISTS prompt_history (id TEXT PRIMARY KEY, ts INTEGER, request TEXT, task_type TEXT)`;
  }

  private remember(request: string, taskType: string) {
    this.ensureTable();
    this.sql`INSERT INTO prompt_history (id, ts, request, task_type) VALUES (${crypto.randomUUID()}, ${Date.now()}, ${request}, ${taskType})`;
  }

  private recentRequests(limit: number): string[] {
    this.ensureTable();
    const rows = this.sql<{ request: string }>`SELECT request FROM prompt_history ORDER BY ts DESC LIMIT ${limit}`;
    return rows.map((r) => r.request);
  }

  async init() {
    this.ensureTable();

    // -------- Tool 1: refine + run (the main event) --------
    this.server.registerTool(
      "pro_prompt",
      {
        title: "Pro Prompt (refine + run)",
        description:
          "Turn a rough request into a FAANG-grade engineered prompt AND immediately execute it — a best-quality answer in one step, with zero extra credits (the host model does the work). Use whenever the user says 'Pro Prompter', or asks to refine/optimize a prompt and get the result.",
        inputSchema: {
          request: z.string().min(1).describe("The user's rough request / rough prompt to engineer and run."),
          model_class: MODEL_CLASS,
          use_memory: z.boolean().optional().describe("Include this session's recent requests as background context. Default true."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ request, model_class, use_memory }) => {
        const history = use_memory === false ? [] : this.recentRequests(3);
        const text = buildRefineAndRun(request, model_class ?? "auto", history);
        this.remember(request, analyze(request).taskType);
        return { content: [{ type: "text", text }] };
      },
    );

    // -------- Tool 2: refine only (return the polished prompt) --------
    this.server.registerTool(
      "refine_prompt",
      {
        title: "Refine prompt (return only)",
        description:
          "Rewrite a rough request into an optimized, reusable prompt and return ONLY that prompt (do not execute it). Use when the user wants the improved prompt itself — to copy, save, or reuse elsewhere.",
        inputSchema: {
          request: z.string().min(1).describe("The user's rough request / rough prompt to engineer."),
          model_class: MODEL_CLASS,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ request, model_class }) => {
        const text = buildRefineOnly(request, model_class ?? "auto");
        this.remember(request, analyze(request).taskType);
        return { content: [{ type: "text", text }] };
      },
    );

    // -------- Tool 3: recall session memory --------
    this.server.registerTool(
      "recall_prompts",
      {
        title: "Recall prompts",
        description: "List the recent requests refined in this Pro Prompter session (its memory), most recent first.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const rows = this.sql<{ request: string; task_type: string; ts: number }>`SELECT request, task_type, ts FROM prompt_history ORDER BY ts DESC LIMIT 20`;
        if (rows.length === 0) {
          return { content: [{ type: "text", text: "No prompts refined in this session yet." }] };
        }
        const list = rows
          .map((r, i) => `${i + 1}. [${r.task_type}] ${r.request.length > 120 ? r.request.slice(0, 117) + "…" : r.request}`)
          .join("\n");
        return { content: [{ type: "text", text: `Pro Prompter memory (${rows.length}):\n${list}` }] };
      },
    );

    // -------- Tool 4: clear session memory (a write action) --------
    this.server.registerTool(
      "clear_memory",
      {
        title: "Clear memory",
        description: "Erase this Pro Prompter session's stored request history.",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async () => {
        this.ensureTable();
        this.sql`DELETE FROM prompt_history`;
        return { content: [{ type: "text", text: "Pro Prompter memory cleared for this session." }] };
      },
    );

    // -------- Prompt (Claude-only nicer UX): a pickable slash-command --------
    this.server.registerPrompt(
      "pro_prompt",
      {
        title: "Pro Prompter",
        description: "Engineer your rough request into a FAANG-grade prompt and run it.",
        argsSchema: { request: z.string().describe("Your rough request / idea.") },
      },
      ({ request }) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: buildRefineAndRun(request, "auto", []) },
          },
        ],
      }),
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return ProPrompter.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return ProPrompter.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/") {
      return new Response(landingPage(url.origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

function landingPage(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pro Prompter — live</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
  code { background: #f2f2f2; padding: .15rem .35rem; border-radius: .25rem; }
  .ok { color: #0a7d28; font-weight: 600; }
</style>
</head>
<body>
  <h1>Pro Prompter <span class="ok">✔ live</span></h1>
  <p>A free <strong>Model Context Protocol</strong> server that rewrites your rough requests into
  FAANG-grade engineered prompts and runs them — using the AI you're already in, at zero extra cost.</p>
  <p>Add it to Claude or ChatGPT with this URL:</p>
  <p><code>${origin}/mcp</code></p>
  <h2>What it adds</h2>
  <ul>
    <li><code>pro_prompt</code> — engineer your request into a top-tier prompt <em>and execute it</em></li>
    <li><code>refine_prompt</code> — return just the polished prompt to copy/reuse</li>
    <li><code>recall_prompts</code> / <code>clear_memory</code> — session memory</li>
  </ul>
  <p>Say <strong>"Pro Prompter: &lt;your rough idea&gt;"</strong> in a chat to use it. Setup: see the README.</p>
</body>
</html>`;
}
