# Pro Prompter 🧠

A free, open-source **plugin for Claude & ChatGPT** that rewrites your rough requests into
**FAANG-grade engineered prompts** and runs them — using the AI you're already talking to, at
**zero extra credits**.

One [MCP](https://modelcontextprotocol.io) server. Works in both Claude and ChatGPT.

## What it does

| Interface | What it does |
|-----------|--------------|
| `pro_prompt` (tool) | Engineer your request into a top-tier prompt **and execute it** — best answer in one step |
| `refine_prompt` (tool) | Return **just** the polished prompt, to copy / save / reuse |
| `recall_prompts` · `clear_memory` (tools) | Per-session memory of your requests |
| `pro_prompt` (prompt) | A pickable slash-command version — **Claude only** |

## How "zero extra credits" actually works (the honest bit)

An MCP plugin **can't secretly rewrite your message before the AI reads it**, and it **can't call an
AI of its own** (Claude/ChatGPT don't allow that in 2026). So Pro Prompter does something smarter:

> Each tool returns a world-class **meta-prompt** (plain text — instant and free). The **AI you're
> already chatting with** reads it and does the rewriting + answering in the same turn. No API key,
> no second bill — it rides on your existing Claude/ChatGPT.

The trade-off: you **invoke it explicitly** (say "Pro Prompter: …" or pick the slash-command). It
can't auto-upgrade every message — that's a hard platform rule, not a missing feature.

The rubric it injects is distilled from Anthropic's and OpenAI's official prompt-engineering guides:
preserve your intent verbatim, add the "why", positive constraints, explicit output format,
model-class-aware reasoning, a complexity gate (no over-engineering simple asks), and strict token
economy (structure, not bloat).

## Use it

In Claude or ChatGPT, once connected:

- **Refine + run:** `Pro Prompter: build a landing page for my bakery`
- **Refine only:** `Pro Prompter, refine only: build a landing page for my bakery`
- **Memory:** `Pro Prompter, what have I asked this session?`

---

## Deploy it (free)

Prereqs: [Node.js](https://nodejs.org) 18+, a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```powershell
cd "path\to\pro-prompter"
npm install
npx wrangler deploy      # logs into Cloudflare, prints your live URL
```

Your connector URL is the printed address **+ `/mcp`**:
```
https://pro-prompter.<your-account>.workers.dev/mcp
```
Open the base URL in a browser to confirm the "✔ live" page.

### Put it on GitHub + auto-deploy (optional)
```powershell
git init; git add .; git commit -m "Pro Prompter"
git branch -M main
git remote add origin https://github.com/<you>/pro-prompter.git
git push -u origin main
```
Then add a `CLOUDFLARE_API_TOKEN` repo secret (Settings → Secrets → Actions) and every push
auto-deploys via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

---

## Connect it

### Claude (any plan, incl. Free)
Settings → **Connectors** → **Add custom connector** → paste the **`/mcp`** URL → **Add**. Leave OAuth
blank. In a chat, enable it via the **+** menu. Claude also shows the `pro_prompt` **slash-command**.

### ChatGPT (Plus/Pro/Business+, desktop web)
Settings → **Connectors** → **Advanced** → **Developer mode** → add the **`/mcp`** URL, Auth **None**.
Enable it in a chat via the tools menu. (ChatGPT ignores the slash-command prompt; use the tool.)

> ⚠️ Use the URL ending in **`/mcp`**. The bare `...workers.dev` is just a status page, not the MCP endpoint.

---

## Extend it
The whole rubric lives in [`src/index.ts`](src/index.ts) (`RUBRIC`, `analyze`, `buildRefineAndRun`).
Tweak the rubric or add task types, then `npx wrangler deploy` (or `git push`).

## License
MIT © 2026 Pranay Mahendrakar — free to use, modify, and share.
