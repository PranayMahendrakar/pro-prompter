/**
 * Pro Prompter — a free, open MCP server that turns a rough request into a
 * FAANG-grade engineered prompt and has the host AI execute it, using ZERO
 * extra API credits.
 *
 * How the "zero credits" trick works:
 *   An MCP server on Claude/ChatGPT cannot call an LLM itself (sampling is
 *   unsupported in 2026), and it can't intercept your message before the AI
 *   reads it. So Pro Prompter runs no AI of its own. Each tool returns a
 *   compact, world-class *meta-prompt* (pure text, instant, free). The host
 *   model — the Claude/ChatGPT you're already talking to — reads it and does
 *   the rewriting + answering in the SAME turn. No API key, no extra bill.
 *
 * Interfaces:
 *   Tool  pro_prompt     -> engineer the prompt AND execute it (refine + run)
 *   Tool  refine_prompt  -> return ONLY the engineered prompt (to copy/reuse)
 *   Tool  recall_prompts -> list this session's recent requests (memory)
 *   Tool  clear_memory   -> wipe this session's memory
 *   Prompt pro_prompt    -> Claude-only slash-command version of refine + run
 *
 * The rubric is intentionally lean (token economy) and specialized per task:
 * a request is classified into one of 15 task types, each of which injects its
 * own expert "must-specify" checklist.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Task-type specs — expert, token-economical checklists (one per task type).
// A request is scored against each spec's keywords; the best match wins.
// ---------------------------------------------------------------------------
type TaskSpec = { key: string; label: string; keywords: string[]; dimensions: string[] };

const TASK_SPECS: TaskSpec[] = [
  {
    key: "coding", label: "coding",
    keywords: ["code", "function", "bug", "debug", "refactor", "implement", "api", "class", "script", "compile", "endpoint", "algorithm", "stack trace", "typescript", "python"],
    dimensions: [
      "State the exact goal and acceptance criteria",
      "Specify language, version, framework, and dependencies",
      "Give codebase context, files, and interfaces",
      "Define inputs, outputs, edge cases, and errors",
      "Set performance, security, and style constraints",
      "Require tests and verification steps",
      "Specify output format: diff vs full files",
    ],
  },
  {
    key: "data", label: "data",
    keywords: ["sql", "query", "csv", "dataframe", "pandas", "spreadsheet", "excel", "chart", "pivot", "aggregate", "group by", "visualize", "columns"],
    dimensions: [
      "Describe the input data: schema, types, sample rows",
      "State the exact goal, metric, or question",
      "Name the engine and dialect (SQL flavor, pandas, Excel)",
      "Specify output shape: columns, format, chart type",
      "Define grain, filters, grouping, and time window",
      "Set null, dedup, and edge-case handling",
    ],
  },
  {
    key: "math", label: "math / logic",
    keywords: ["solve", "prove", "theorem", "equation", "integral", "derivative", "probability", "combinatorics", "algebra", "calculus", "inequality", "word problem", "compute", "how many", "optimization"],
    dimensions: [
      "State the exact problem, givens, and unknown",
      "Specify rigor: full proof vs final answer",
      "Demand step-by-step derivation, no skipped algebra",
      "Fix answer format, units, and precision",
      "Require a verification / sanity-check of the result",
      "Name allowed methods, theorems, or constraints",
    ],
  },
  {
    key: "extraction", label: "data extraction",
    keywords: ["extract", "parse", "structured data", "json", "fields", "schema", "key-value", "scrape", "pull out", "normalize", "entities", "table to json"],
    dimensions: [
      "Provide the source text / input verbatim",
      "Define the exact output schema, field names, and types",
      "Specify handling for missing or ambiguous values",
      "State output format and strict serialization rules",
      "Give per-field normalization (dates, units, casing)",
      "Constrain to the source; forbid inference or fabrication",
    ],
  },
  {
    key: "translation", label: "translation",
    keywords: ["translate", "translation", "localize", "localization", "l10n", "i18n", "into spanish", "into french", "target language", "source language", "locale", "transcreate", "subtitle", "bilingual", "multilingual"],
    dimensions: [
      "Name source and target languages plus locale",
      "Specify register, tone, and target audience",
      "State domain and subject-matter terminology",
      "Set depth: literal vs adapt idioms and units",
      "Supply glossary, brand terms, do-not-translate list",
      "Define formatting, placeholder, and markup handling",
    ],
  },
  {
    key: "image", label: "image generation",
    keywords: ["image", "picture", "photo", "illustration", "render", "artwork", "midjourney", "dall-e", "stable diffusion", "generate an image", "poster", "logo", "concept art", "portrait", "aspect ratio"],
    dimensions: [
      "Name subject, count, and defining attributes",
      "State style, medium, or artistic reference",
      "Specify composition, shot framing, and angle",
      "Define lighting, mood, and color palette",
      "Set setting, background, and environment detail",
      "Give aspect ratio, resolution, and quality",
      "List exclusions via negatives / constraints",
    ],
  },
  {
    key: "design", label: "design",
    keywords: ["design", "ui", "ux", "landing page", "website", "layout", "wireframe", "mockup", "dashboard", "web design", "responsive", "figma", "hero section", "typography", "redesign"],
    dimensions: [
      "State goal, target audience, and brand personality",
      "Specify platform, viewport, and responsive breakpoints",
      "Name the visual style with reference examples",
      "Define color palette, typography, and spacing",
      "Map sections, content hierarchy, and primary CTA",
      "Set output format, tech stack, and fidelity",
      "Require accessibility and component states",
    ],
  },
  {
    key: "research", label: "research",
    keywords: ["research", "find sources", "cite", "citations", "literature review", "market scan", "evidence", "state of the art", "fact-check", "landscape", "survey", "who are the", "statistics"],
    dimensions: [
      "State the precise question and scope boundaries",
      "Require citations with source-credibility and recency limits",
      "Set time-frame, geography, and domain filters",
      "Define output structure, length, and comparison format",
      "Specify depth, breadth, and minimum source count",
      "Demand flagging of gaps, conflicts, and uncertainty",
    ],
  },
  {
    key: "strategy", label: "strategy",
    keywords: ["strategy", "roadmap", "go-to-market", "gtm", "prioritize", "trade-off", "tradeoff", "positioning", "business model", "market entry", "competitive advantage", "pricing strategy", "monetization", "build vs buy", "okrs"],
    dimensions: [
      "State company, market, stage, and hard constraints",
      "Frame the decision and the alternatives",
      "Define objectives, success metrics, and time horizon",
      "Give prioritization criteria and risk tolerance",
      "Supply key data, assumptions, and open unknowns",
      "Specify the deliverable: recommendation, rationale, trade-offs",
    ],
  },
  {
    key: "marketing", label: "marketing",
    keywords: ["ad", "ads", "campaign", "headline", "cta", "social post", "tweet", "newsletter", "launch", "growth", "conversion", "brand voice", "landing page copy"],
    dimensions: [
      "Name target audience, pain, and awareness stage",
      "State product, value prop, and differentiator",
      "Specify channel, format, and length limits",
      "Define objective, CTA, and success metric",
      "Set brand voice, tone, and forbidden claims",
      "Provide proof points, offer, and hook angle",
      "Request the number of variants and output structure",
    ],
  },
  {
    key: "analysis", label: "analysis",
    keywords: ["analyze", "analysis", "compare", "comparison", "evaluate", "evaluation", "assess", "critique", "pros and cons", "trade-offs", "recommend", "versus", "vs", "weigh options", "should i", "which is better"],
    dimensions: [
      "State the decision or question and desired verdict",
      "List options and evaluation criteria with weights",
      "Provide context, constraints, and success goals",
      "Set audience, depth, and output format",
      "Demand evidence, reasoning, and trade-off transparency",
      "Require an explicit recommendation with caveats and risks",
    ],
  },
  {
    key: "planning", label: "planning",
    keywords: ["plan", "roadmap", "schedule", "timeline", "milestones", "project plan", "phases", "task breakdown", "gantt", "sprint", "backlog", "deadline", "action plan", "workback"],
    dimensions: [
      "State goal, scope, and success criteria",
      "Give timeframe, start date, and hard deadlines",
      "List resources, team, budget, and constraints",
      "Name dependencies, risks, and assumptions",
      "Specify output format and task granularity",
      "Define milestones, checkpoints, and non-goals",
    ],
  },
  {
    key: "tutoring", label: "tutoring / explaining",
    keywords: ["explain", "teach", "learn", "understand", "tutor", "concept", "eli5", "walk me through", "beginner", "intuition", "how does", "simplify", "break down", "lesson"],
    dimensions: [
      "State learner level and prior knowledge",
      "Define the learning goal and target depth",
      "Request analogies, concrete examples, step-by-step buildup",
      "Specify format, length, and structure",
      "Include comprehension checks or practice questions",
      "Flag common misconceptions and pitfalls",
    ],
  },
  {
    key: "summarization", label: "summarization",
    keywords: ["summarize", "summary", "tldr", "tl;dr", "condense", "recap", "abstract", "digest", "key points", "gist", "shorten", "synopsis", "boil down", "takeaways"],
    dimensions: [
      "State the target length or compression ratio",
      "Specify output format (bullets, prose, structured)",
      "Define the audience and purpose",
      "Name must-keep elements and the focus",
      "Set fidelity: source-only, add no new facts",
      "Say whether to preserve key quotes or numbers",
    ],
  },
  {
    key: "writing", label: "writing",
    keywords: ["write", "essay", "article", "blog", "email", "story", "copy", "draft", "rewrite", "newsletter", "prose", "narrative", "tagline", "caption", "letter", "post"],
    dimensions: [
      "Define audience, purpose, and desired reader action",
      "Set voice, tone, and reading level",
      "Specify format, length, and structure",
      "Provide key points, facts, and sources",
      "Give the context, angle, or core message",
      "State constraints: banned words, must-includes, CTA",
    ],
  },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detect(request: string): TaskSpec | null {
  const t = request.toLowerCase();
  let best: TaskSpec | null = null;
  let bestScore = 0;
  for (const spec of TASK_SPECS) {
    let score = 0;
    for (const kw of spec.keywords) {
      if (new RegExp(`\\b${escapeRe(kw)}\\b`, "i").test(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = spec;
    }
  }
  return bestScore > 0 ? best : null;
}

function isComplex(request: string): boolean {
  const wc = (request.match(/\S+/g) ?? []).length;
  return wc > 12 || /\b(detailed|comprehensive|production|in depth|thorough|complex|architecture|end.to.end|step by step)\b/i.test(request);
}

const CORE =
  'CORE — set a role only if it changes behavior; give context + the "why" once; one precise action-verb task with a clear "done"; positive constraints, no contradictions; explicit output format; examples only if format/edge-cases need them; success criteria + a self-check.';

function reasoningLine(modelClass: string): string {
  return modelClass === "chat"
    ? "REASONING — for multi-step logic, reason inside <thinking> tags, then answer in <answer> tags."
    : "REASONING — the executor is a reasoning model: give goal + constraints + success criteria; do NOT add \"think step by step\".";
}

function taskBlock(spec: TaskSpec | null): string {
  if (!spec) return "";
  const bullets = spec.dimensions.map((d) => `  • ${d}`).join("\n");
  return `FOR THIS ${spec.label.toUpperCase()} TASK, make the prompt nail:\n${bullets}\n`;
}

function complexityGuard(request: string): string {
  return isComplex(request) ? "" : "This is a small ask — include only the checklist items that matter here and stay concise.\n";
}

function memoryBlock(history: string[]): string {
  if (history.length === 0) return "";
  const lines = history.map((h) => `  • ${h.length > 140 ? h.slice(0, 137) + "…" : h}`).join("\n");
  return `SESSION CONTEXT — earlier requests you may build on (most recent first):\n${lines}\n\n`;
}

function buildRefineAndRun(request: string, modelClass: string, history: string[]): string {
  const spec = detect(request);
  return `🧠 PRO PROMPTER — engineer, then execute.

Act as an elite, FAANG-level prompt engineer AND the executor. Rewrite the RAW REQUEST into ONE optimally-engineered prompt, then carry it out. Add structure and signal, never padding.

${CORE}
${taskBlock(spec)}${reasoningLine(modelClass)}
${complexityGuard(request)}Preserve every user detail and {variable} verbatim; invent nothing; keep it dense.

Reply in EXACTLY this shape:
**🎯 Engineered prompt**
<the rewritten prompt>
**✅ Result**
<execute the engineered prompt in full, to the highest standard — no preamble, no confirmation>

${memoryBlock(history)}RAW REQUEST
<<<
${request}
>>>`;
}

function buildRefineOnly(request: string, modelClass: string): string {
  const spec = detect(request);
  return `🧠 PRO PROMPTER — engineer only (do not execute).

Act as an elite, FAANG-level prompt engineer. Rewrite the RAW REQUEST into ONE optimally-engineered prompt.

${CORE}
${taskBlock(spec)}${reasoningLine(modelClass)}
${complexityGuard(request)}Preserve every user detail and {variable} verbatim; invent nothing; keep it dense.

Output ONLY the engineered prompt — ready to copy and reuse. Do NOT execute it, and add no commentary.

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
  server = new McpServer({ name: "Pro Prompter", version: "1.1.0" });

  private ensureTable() {
    this.sql`CREATE TABLE IF NOT EXISTS prompt_history (id TEXT PRIMARY KEY, ts INTEGER, request TEXT, task_type TEXT)`;
  }

  private remember(request: string) {
    this.ensureTable();
    const taskType = detect(request)?.key ?? "general";
    this.sql`INSERT INTO prompt_history (id, ts, request, task_type) VALUES (${crypto.randomUUID()}, ${Date.now()}, ${request}, ${taskType})`;
  }

  private recentRequests(limit: number): string[] {
    this.ensureTable();
    const rows = this.sql<{ request: string }>`SELECT request FROM prompt_history ORDER BY ts DESC LIMIT ${limit}`;
    return rows.map((r) => r.request);
  }

  async init() {
    this.ensureTable();

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
        this.remember(request);
        return { content: [{ type: "text", text }] };
      },
    );

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
        this.remember(request);
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.registerTool(
      "recall_prompts",
      {
        title: "Recall prompts",
        description: "List the recent requests refined in this Pro Prompter session (its memory), most recent first.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const rows = this.sql<{ request: string; task_type: string }>`SELECT request, task_type FROM prompt_history ORDER BY ts DESC LIMIT 20`;
        if (rows.length === 0) {
          return { content: [{ type: "text", text: "No prompts refined in this session yet." }] };
        }
        const list = rows
          .map((r, i) => `${i + 1}. [${r.task_type}] ${r.request.length > 120 ? r.request.slice(0, 117) + "…" : r.request}`)
          .join("\n");
        return { content: [{ type: "text", text: `Pro Prompter memory (${rows.length}):\n${list}` }] };
      },
    );

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

    this.server.registerPrompt(
      "pro_prompt",
      {
        title: "Pro Prompter",
        description: "Engineer your rough request into a FAANG-grade prompt and run it.",
        argsSchema: { request: z.string().describe("Your rough request / idea.") },
      },
      ({ request }) => ({
        messages: [
          { role: "user", content: { type: "text", text: buildRefineAndRun(request, "auto", []) } },
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
  FAANG-grade engineered prompts and runs them — using the AI you're already in, at zero extra cost.
  Specialized across 15 task types (coding, writing, design, data, research, and more).</p>
  <p>Add it to Claude or ChatGPT with this URL:</p>
  <p><code>${origin}/mcp</code></p>
  <p>Say <strong>"Pro Prompter: &lt;your rough idea&gt;"</strong> in a chat to use it. Setup: see the README.</p>
</body>
</html>`;
}
