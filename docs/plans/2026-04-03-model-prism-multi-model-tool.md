# Model Prism — Multi-Model Analysis Tool

## Context

Paste any content (room review, copy draft, strategy doc), fan it out to dozens of LLMs via OpenRouter, get back a synthesized analysis showing where models agree, disagree, and what unique insights each surfaces. Replaces tab-switching hell.

## Decisions (Confirmed)

1. **Repo:** `C:\Dev\Tools\ModelPrism`
2. **Deploy:** Vercel — but with Turso (serverless SQLite) instead of local better-sqlite3, and client-driven fan-out to dodge serverless timeouts
3. **Synthesis model:** User picks per run — toggle Sonnet (fast/cheap) vs Opus (deep)

## Architecture (Post-Review Fixes)

The original plan had fatal flaws caught in review. Here's the corrected architecture:

### Fix 1: Turso instead of better-sqlite3
Local SQLite on Vercel = data loss on every cold start. **Turso** gives the same SQLite DX but persists over the wire. Free tier = 9GB, 500M rows — more than enough.

### Fix 2: Client-Driven Fan-Out (Inverted Orchestration)
Vercel free tier = 10-15s function timeout. 50 models can take 30-90s. Solution: the **browser** orchestrates the fan-out.

```
Browser (orchestrator)
  │
  ├─► POST /api/invoke-model { model: "claude-sonnet", content, prompt }
  │     └─► Proxies to OpenRouter (hides API key) → returns response
  │
  ├─► POST /api/invoke-model { model: "gpt-4o", content, prompt }
  │     └─► Same proxy, different model
  │
  ├─► ... (up to 50 concurrent, throttled with p-limit(8))
  │
  └─► All done → POST /api/synthesize { runId, responses[] }
        └─► Calls Anthropic → returns structured synthesis
```

Each serverless invocation waits for ONE model (~5-30s). Browser handles concurrency. No monolithic timeout.

### Fix 3: API Keys in localStorage
Can't write .env.local at runtime. Keys live in the browser's localStorage, passed to API routes via headers. Vercel URL is safe — no key on the server to drain.

### Fix 4: Synthesis Hardening
- **XML tags** instead of `=== MODEL ===` delimiters (Claude is trained on XML)
- **Cap fan-out outputs** to `max_tokens: 600` — prevents rambling, reduces synthesis cost
- **Zod schema + Vercel AI SDK `generateObject`** — guaranteed structured JSON, no parse failures
- **Prompt caching** on the synthesis call — 80% cost reduction on repeated schemas

### Fix 5: Smart Model Selection
- Pull `context_length` from OpenRouter `/models` endpoint
- Client-side token estimation (tiktoken-lite or gpt-tokenizer)
- Gray out models that can't handle the input size
- Group by **base architecture** not just price — flag when 6 Llama variants would create false consensus

### Fix 6: UI Performance
- Throttle SSE-style updates to 100ms intervals via `requestAnimationFrame`
- Accumulate tokens in refs, flush to React state in batches
- Prevents DOM freeze when 50 cards update simultaneously

### Fix 7: Rate Limit Resilience
- `p-limit(8)` on client-side concurrent requests
- Exponential backoff on 429s (2 retries)
- After 2 failures: mark as "Failed: Provider Overloaded" — don't crash the batch

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | Next.js 15 (App Router) | Familiar, API routes built in |
| Runtime | Bun | Already installed |
| Styling | Tailwind CSS | Fast to build |
| UI | shadcn/ui | Copy-paste components |
| Database | **Turso (LibSQL)** | Serverless SQLite, Vercel-compatible |
| AI SDK | **Vercel AI SDK** | `generateObject` with Zod for typed synthesis |
| Multi-model | OpenRouter | One key, 200+ models |
| Synthesis | Anthropic API via AI SDK | Structured output, prompt caching |
| Concurrency | **p-limit** | Client-side request throttling |
| Token counting | **gpt-tokenizer** | Client-side input size estimation |
| Deploy | Vercel free tier | Personal tool |

## Pages & Components

### Page 1: New Run (`/`)

**Input Panel (left 40%):**
- Large textarea for pasting content
- Token count display (updates as you type)
- Prompt template selector (dropdown) + editable prompt field
- Model picker:
  - Grouped by **base architecture**: Claude family, GPT family, Llama family, Gemini family, Mistral family, Other
  - Sub-grouped by tier within each family
  - "Select all in tier" toggles
  - Presets: "All Frontier" (5-8), "Diverse Sweep" (1 per family per tier), "Full Spread"
  - Models that can't fit the input are **grayed out** with tooltip showing context limit
  - Per-model cost estimate
- Total estimated cost
- "Run Analysis" button

**Progress Panel (right 60%, appears on run):**
- Cards appear as responses land (throttled renders)
- Each card: model name, response time, tokens, cost
- Collapsed by default (first 2 lines), expandable
- Progress bar: "23 of 50 complete"
- Failed models shown with error reason

### Page 2: Results (`/runs/[id]`)

**Synthesis Section (top):**
- **Consensus** — points 60%+ of unique base architectures agree on
- **Unique Insights** — ideas from only 1-2 models (the gold)
- **Disagreements** — where models contradict, grouped by topic
- **Blind Spots** — prompt aspects most models skipped
- **Theme Heatmap** — matrix of themes vs models, color-coded coverage (0-3)

**Individual Responses (below):**
- Sortable: response time, cost, length, uniqueness score
- Filterable by family/tier
- Expandable cards
- Side-by-side compare (pick 2-3)

### Page 3: History (`/history`)
- Past runs: date, prompt preview, model count, cost
- Click to reopen, "Re-run with different models" button

### Page 4: Settings (`/settings`)
- API key inputs → saved to **localStorage** (never server)
- Key validation (test call on save)
- Default model presets
- Prompt template CRUD
- Synthesis model preference (Sonnet/Opus default)

## API Routes

### `POST /api/invoke-model`
Single-model proxy. Receives model ID + content + prompt + API key (via header). Calls OpenRouter. Returns response + usage stats. One invocation = one model = fits in Vercel timeout.

### `POST /api/save-response`
Writes a single model response to Turso. Called by the client after each model completes.

### `POST /api/synthesize`
Takes runId, fetches all responses from Turso, builds XML-tagged prompt, calls Anthropic via AI SDK `generateObject` with Zod schema. Saves synthesis to Turso. Returns typed result.

### `GET /api/models`
Fetches OpenRouter `/api/v1/models`, caches 1 hour (Vercel KV or in-memory), returns grouped by family + tier with pricing + context_length.

### `GET /api/runs/[id]`
Fetches run + responses + synthesis from Turso.

### `POST /api/runs`
Creates a new run record. Returns runId.

## Database Schema (Turso/SQLite)

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  prompt TEXT NOT NULL,
  models TEXT NOT NULL,        -- JSON array of selected model IDs
  total_cost REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id),
  model TEXT NOT NULL,
  base_architecture TEXT,      -- "llama-3", "claude", "gpt-4", etc.
  response TEXT,
  error TEXT,
  time_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE syntheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id),
  result TEXT NOT NULL,        -- JSON (Zod-validated)
  model_used TEXT NOT NULL,    -- which Claude model ran synthesis
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE prompt_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Synthesis Zod Schema

```typescript
const SynthesisSchema = z.object({
  consensus: z.array(z.object({
    point: z.string(),
    supporting_models: z.array(z.string()),
    strength: z.enum(["strong", "moderate", "weak"]),
  })),
  unique_insights: z.array(z.object({
    model: z.string(),
    insight: z.string(),
    significance: z.enum(["high", "medium", "low"]),
  })),
  disagreements: z.array(z.object({
    topic: z.string(),
    positions: z.array(z.object({
      models: z.array(z.string()),
      position: z.string(),
    })),
  })),
  blind_spots: z.array(z.string()),
  theme_matrix: z.array(z.object({
    theme: z.string(),
    scores: z.record(z.string(), z.number().min(0).max(3)),
  })),
});
```

## Synthesis Prompt (XML-tagged)

```xml
You are analyzing responses from {N} AI models (across {M} distinct architectures) to the same prompt.

<original_content truncated="true">{first 2000 chars}</original_content>
<analysis_prompt>{prompt}</analysis_prompt>

<responses>
  <model_response id="anthropic/claude-sonnet-4-6" architecture="claude">
    {response, max 600 tokens}
  </model_response>
  <model_response id="openai/gpt-4o" architecture="gpt-4">
    {response}
  </model_response>
  ...
</responses>

IMPORTANT: When calculating consensus, weight by distinct base architecture — 
6 Llama variants agreeing counts as 1 vote, not 6.

Return your analysis as structured JSON matching the provided schema.
```

## Default Prompt Templates

1. **Room Review Analysis** — design quality, missed details, improvement ideas, pricing accuracy
2. **Copy Critique** — tone, clarity, persuasiveness, target audience fit, CTAs
3. **Strategy Pressure Test** — assumptions, risks, missing perspectives, competitive blindspots
4. **Code Review** — bugs, security, performance, readability, architecture
5. **General Analysis** — open-ended, let models interpret freely

## File Structure

```
model-prism/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                     # New Run
│   ├── history/page.tsx
│   ├── runs/[id]/page.tsx           # Results
│   ├── settings/page.tsx
│   └── api/
│       ├── invoke-model/route.ts    # Single-model proxy
│       ├── save-response/route.ts
│       ├── synthesize/route.ts
│       ├── models/route.ts
│       └── runs/
│           ├── route.ts             # POST create run
│           └── [id]/route.ts        # GET run + responses
├── components/
│   ├── input-panel.tsx
│   ├── model-picker.tsx
│   ├── progress-panel.tsx
│   ├── synthesis-view.tsx
│   ├── response-card.tsx
│   ├── theme-heatmap.tsx
│   ├── compare-view.tsx
│   ├── run-history-list.tsx
│   ├── api-key-input.tsx
│   └── ui/                          # shadcn
├── lib/
│   ├── openrouter.ts                # OpenRouter client
│   ├── db.ts                        # Turso client + queries
│   ├── synthesis.ts                 # Prompt builder + Zod schema
│   ├── model-registry.ts            # Families, tiers, context limits
│   ├── token-estimator.ts           # Client-side token counting
│   ├── fan-out.ts                   # Client-side orchestrator (p-limit)
│   └── types.ts
├── .env.local
├── .env.example
├── package.json
├── next.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

## Build Phases

### Phase 1: Core Loop (MVP)
- Next.js scaffold + Tailwind + shadcn
- Input panel (textarea + prompt field)
- Hardcoded model list (10 diverse models)
- `/api/invoke-model` proxy route
- Client-side fan-out with p-limit(8)
- Basic results page showing response cards
- No persistence, no synthesis
- **Verify:** paste text → get 10 responses displayed

### Phase 2: Synthesis + Persistence
- Turso setup + schema
- Save runs + responses to Turso
- `/api/synthesize` with AI SDK generateObject + Zod
- Synthesis view (consensus, insights, disagreements, blind spots)
- Run history page
- **Verify:** full loop — paste → fan out → synthesize → refresh → data persists

### Phase 3: Smart Models + Polish
- Live model list from OpenRouter API
- Model picker grouped by family + tier
- Token estimation + context limit filtering
- Base architecture tagging (echo chamber prevention)
- Cost tracking per run
- Theme heatmap
- Prompt template management (CRUD in settings)
- API key management (localStorage)
- Side-by-side compare
- Synthesis model toggle (Sonnet/Opus)
- **Verify:** use presets, verify cost display, compare responses, check heatmap

## Cost Estimates

| Scenario | Fan-out Cost | Synthesis Cost | Total |
|----------|-------------|---------------|-------|
| 5 frontier models | ~$0.05 | ~$0.02 (Sonnet) | ~$0.07 |
| 20 diverse models | ~$0.15 | ~$0.05 (Sonnet) | ~$0.20 |
| 50 all models | ~$0.40 | ~$0.10 (Sonnet) / $0.75 (Opus) | ~$0.50-1.15 |

With `max_tokens: 600` cap on fan-out responses and prompt caching on synthesis.
