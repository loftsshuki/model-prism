# Model Prism — Product Document

**Repo:** `C:\Dev\Tools\model-prism` | [GitHub](https://github.com/loftsshuki/model-prism)
**Live:** https://model-prism.vercel.app
**Created:** 2026-04-03
**Status:** Production — 18 commits, fully deployed

---

## What It Does

Paste any content — a plan, review, copy draft, strategy doc, code — select models from 200+ LLMs, fan them all out via OpenRouter, and get every response back. Then Claude reads all responses and produces a master synthesis document that cherry-picks the best insights from every model into one definitive, actionable analysis.

The core value: instead of asking one AI for an opinion, you ask 50 and get the superposition of all their thinking.

---

## Architecture

```
Browser (orchestrator)
  │
  ├─► Free models: browser → OpenRouter directly (no timeout limit)
  │
  ├─► Paid models: browser → /api/invoke-model → OpenRouter (50s proxy, hides API key)
  │
  └─► All done → /api/synthesize → Anthropic Claude → Master Document
        │
        └─► Neon Postgres (runs, responses, syntheses persisted)
```

**Key design decisions:**
- **Client-driven fan-out** — browser orchestrates all requests, bypasses Vercel serverless timeouts
- **Free models call OpenRouter directly** from the browser — no 60s Vercel limit
- **Paid models proxy through the server** — hides the API key
- **API keys in localStorage** — never stored on the server, passed via request body
- **p-limit concurrency** — 6 concurrent for paid, 1 sequential for free (shared rate limits)

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 15 (App Router) |
| Runtime | Bun |
| Styling | Tailwind CSS 4 |
| UI Components | Custom (LuxuryApartments design system) |
| Database | Neon Postgres (via Vercel integration) |
| AI SDK | Vercel AI SDK + Zod `generateObject` |
| Multi-model API | OpenRouter (200+ models) |
| Synthesis | Anthropic API (Claude Sonnet or Opus, user picks) |
| Concurrency | p-limit (6 paid, 1 free) |
| Deploy | Vercel (free tier) |

---

## Design System

LuxuryApartments editorial theme:
- **Background:** cream `#FAF8F5`
- **Primary:** deep green `#2D4A3E`
- **Accent:** gold `#8B6F47`
- **Display font:** Cormorant Garamond (headings)
- **Body font:** Outfit (text)
- **Layout:** 50-50 split — fixed sidebar left, scrollable results right
- **Corners:** sharp (no border-radius)
- **Patterns:** overline text + decorative line section headers, left-border accent lines

---

## Pages

### `/` — Main Analysis Tool

**Left panel (50%):**
- Content textarea with token estimate
- Prompt template selector (dropdown + editable)
- Model picker grouped by tier (Frontier / Strong / Fast / Free)
- Preset buttons: All Frontier, Diverse Sweep, Free Only, All
- Context length filtering — grays out models too small for input
- Per-run cost estimate
- Run / Add More Models / Stop button with elapsed timer

**Right panel (50%):**
- Progress bar with completion count and timer
- Action bar: Synthesize All, Retry Failed, Copy All to Clipboard, Compare
- Master Synthesis document (hero output)
- Structured breakdown toggle (consensus, unique insights, disagreements, blind spots, theme heatmap)
- Response cards (expandable, sortable by completion)

### `/history` — Run History

- List of past runs with date, prompt preview, model count, cost
- Click to view saved results

### `/runs/[id]` — Saved Run Viewer

- Full run details: prompt, content, metadata
- Synthesis view (if synthesized)
- All individual responses
- **Re-run with different models** button (pre-fills home page)
- **Export .md** button (downloads full markdown file)

### `/settings` — Configuration

- API key management (OpenRouter + Anthropic) — stored in localStorage
- Synthesis model toggle (Sonnet vs Opus)
- Built-in prompt templates (read-only)
- Custom prompt template CRUD (localStorage)

---

## Prompt Templates

| Template | What it does |
|----------|-------------|
| Room Review Analysis | Design quality, accuracy, missed details, pricing justification |
| Copy Critique | Tone, clarity, persuasiveness, audience fit, CTA effectiveness |
| Strategy Pressure Test | Assumptions, risks, missing perspectives, competitive blind spots |
| Code Review | Bugs, security, performance, readability, architecture |
| **Plan Teardown** | 5 dimensions: fatal flaws (detonation + defusal), landmines, gaps, turbocharges, execution risks |
| General Analysis | Open-ended themes, strengths, weaknesses, recommendations |

Custom templates can be created in Settings.

---

## Model Tiers

| Tier | Description | Concurrency | Retry |
|------|-------------|-------------|-------|
| **Frontier** | Claude Opus/Sonnet, GPT-4o, Gemini Pro, Grok | 6 concurrent | 2 retries, 2-4s backoff |
| **Strong** | Claude Haiku, GPT-4o Mini, DeepSeek V3, Gemini Flash | 6 concurrent | 2 retries, 2-4s backoff |
| **Fast** | Llama 70B, Mistral Large, Qwen 72B | 6 concurrent | 2 retries, 2-4s backoff |
| **Free** | 25+ free models on OpenRouter | 1 sequential | 5 retries, 5-30s exponential backoff |

**Model filtering:** Non-text models are excluded (image gen, video, audio, music, embeddings, moderation, uncensored). Context length filtering grays out models that can't fit the input.

---

## Synthesis

When all models complete (or user triggers manually), Claude reads every response and produces:

1. **Master Document** — the hero output. A single coherent analysis incorporating the best insights from ALL responses. Written as one authoritative piece, not a summary. Ends with a prioritized action list.

2. **Structured Breakdown** (collapsed by default):
   - **Consensus** — points 60%+ of distinct architectures agree on
   - **Unique Insights** — ideas only 1-2 models surfaced (the gold)
   - **Disagreements** — where models contradict each other
   - **Blind Spots** — aspects most models ignored
   - **Theme Heatmap** — 4-8 themes scored 0-3 per model, color-coded grid

Synthesis uses Zod `generateObject` for guaranteed structured JSON output. User picks Sonnet (fast, ~$0.02) or Opus (deep, ~$0.10).

---

## Run Controls

| Control | What it does |
|---------|-------------|
| **Run Analysis** | Start a fresh run with selected models |
| **Add N More Models** | After a run, select additional models and append to existing results |
| **Stop** | Cancel pending models, keep completed responses |
| **Retry N Failed** | Re-run only 429/502/503 failures (skips 404s) |
| **Synthesize All** | Manually trigger synthesis if it didn't auto-run |
| **Copy All to Clipboard** | Dump all responses formatted for pasting into Claude/ChatGPT |
| **Compare (N)** | Side-by-side view of selected responses (unlimited selection) |
| **Export .md** | Download full run as markdown (on saved runs) |

---

## Persistence

**Neon Postgres** via Vercel integration. Tables auto-created on first request.

| Table | What it stores |
|-------|---------------|
| `runs` | id, content, prompt, models, total_cost, created_at |
| `responses` | run_id, model, model_name, base_architecture, response, error, time_ms, tokens, cost |
| `syntheses` | run_id, result (JSON), model_used |

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/invoke-model` | POST | Proxy to OpenRouter for paid models (50s timeout) |
| `/api/models` | GET | Fetch + cache OpenRouter model list (1hr TTL) |
| `/api/runs` | GET/POST | List runs / create new run |
| `/api/runs/[id]` | GET | Fetch run with responses + synthesis |
| `/api/save-response` | POST | Persist individual model response |
| `/api/synthesize` | POST | Run Claude synthesis via AI SDK |

---

## File Structure

```
model-prism/
├── src/
│   ├── app/
│   │   ├── page.tsx                     # Main analysis tool
│   │   ├── layout.tsx                   # Root layout
│   │   ├── globals.css                  # Design tokens + theme
│   │   ├── history/page.tsx             # Run history
│   │   ├── runs/[id]/page.tsx           # Saved run viewer
│   │   ├── settings/page.tsx            # API keys + templates
│   │   └── api/
│   │       ├── invoke-model/route.ts    # OpenRouter proxy
│   │       ├── models/route.ts          # Model list + cache
│   │       ├── synthesize/route.ts      # Claude synthesis
│   │       ├── save-response/route.ts   # Persist response
│   │       └── runs/
│   │           ├── route.ts             # List/create runs
│   │           └── [id]/route.ts        # Get run detail
│   ├── components/
│   │   ├── model-picker.tsx             # Tier-grouped model selector
│   │   ├── response-card.tsx            # Individual model response
│   │   ├── synthesis-view.tsx           # Master doc + breakdown
│   │   ├── theme-heatmap.tsx            # Coverage matrix
│   │   └── compare-view.tsx             # Side-by-side overlay
│   └── lib/
│       ├── fan-out.ts                   # Client-side orchestrator
│       ├── synthesis.ts                 # Zod schema + prompt builder
│       ├── model-registry.ts            # Fallback models + utilities
│       ├── prompts.ts                   # Default templates
│       ├── db.ts                        # Neon Postgres client
│       ├── types.ts                     # Shared types
│       └── utils.ts                     # cn() helper
├── vercel.json                          # Function timeouts
├── SETUP.md                             # Setup guide
└── PLAN.md                              # This file
```

---

## Setup

**Local dev:**
```bash
cd C:\Dev\Tools\model-prism
bun install
bun dev
```

**API keys:** Set in the app UI (Settings page or header). Stored in browser localStorage.
- **OpenRouter:** https://openrouter.ai/keys
- **Anthropic:** https://console.anthropic.com

**Database:** Neon Postgres provisioned via Vercel integration. `DATABASE_URL` auto-set. Tables auto-created on first request.

**Deploy:** Push to `master` — GitHub integration auto-deploys to Vercel.
