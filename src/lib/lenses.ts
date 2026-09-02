/**
 * Review lenses — prompt-level diversity for the council.
 *
 * Ten models given the identical prompt converge on the same five obvious
 * findings. Assigning each member a lens (security, migrations, rollout, ...)
 * makes the council's coverage come from BOTH the model and the prompt, and
 * spreading lenses round-robin across model families means a family's shared
 * blind spots are not all pointed at the same corner of the plan.
 *
 * Browser-safe: no node imports (the web app assigns lenses client-side).
 */

export interface ReviewLens {
  id: string;
  name: string;
  /** 2-4 sentence instruction block. Adversarial and specific, not generic advice. */
  focus: string;
  /** Finding categories (see findings.ts FINDING_CATEGORIES) this lens should file under. */
  categories: string[];
}

// Ordered by priority: with fewer models than lenses, the first N are used, so
// the lenses that catch shipped-to-production breakage come before the ones
// that catch polish problems.
export const REVIEW_LENSES: ReviewLens[] = [
  {
    id: "correctness-and-logic",
    name: "Correctness & Logic",
    focus:
      "Trace every state transition and branch the plan describes and find the input that makes it wrong: " +
      "empty lists, null/undefined, duplicates, unicode, concurrent writers, retries that replay a side effect, clock skew, and off-by-one boundaries. " +
      "Check that every 'X already handles this' claim is actually true against the verified facts and provided context, and flag any step whose success depends on an unstated assumption. " +
      "Prefer a concrete failing scenario ('two requests with the same idempotency key arrive 5ms apart') over abstract worry.",
    categories: ["correctness"],
  },
  {
    id: "security",
    name: "Security",
    focus:
      "Assume the author is honest and an attacker is reading the same plan. Enumerate every trust boundary the plan crosses (request → handler, server → database, app → third party, model output → prompt) and ask what unvalidated data crosses it. " +
      "Look for missing authorization on new routes (not just authentication), IDOR via user-supplied ids, secrets in logs or client bundles, prompt injection through embedded content, SSRF from user-supplied URLs, and RLS/policy gaps when a table is introduced. " +
      "A finding must name the boundary, the payload, and what the attacker gets.",
    categories: ["security"],
  },
  {
    id: "data-and-migrations",
    name: "Data & Migrations",
    focus:
      "Every schema or data change is a one-way door until proven otherwise. For each migration ask: is it reversible, does it lock a hot table, does it require a backfill and is the backfill idempotent and resumable, and what does the app do during the window when old and new code both run? " +
      "Hunt for dual-write windows without reconciliation, NOT NULL added to populated columns, missing indexes for the new query patterns, foreign keys that block deletes, enum changes that break deployed clients, and new tables without row-level security or an ownership column. " +
      "State which step corrupts or strands data if it fails halfway.",
    categories: ["data"],
  },
  {
    id: "testing-and-verification",
    name: "Testing & Verification",
    focus:
      "Decide whether the plan's success is observable. For each behaviour it promises, name the test that would fail today and pass after, and flag promises with no such test. " +
      "Distrust 'tested manually', mocks that assert on the mock, snapshot tests of generated output, and integration paths (auth, webhooks, cron, streaming) that the plan leaves to staging. " +
      "Point out where a regression would be silent: no assertion on the error path, no test for the concurrency case, no check that the migration ran.",
    categories: ["testing"],
  },
  {
    id: "performance-and-scale",
    name: "Performance & Scale",
    focus:
      "Find the step whose cost grows with data the plan does not mention: N+1 queries hiding behind a loop, unbounded SELECTs, full-table scans introduced by a new filter, payloads or prompts that grow with history, fan-outs without concurrency limits, and caches with no eviction or invalidation story. " +
      "Estimate the first number that breaks (rows, users, requests/sec, tokens) rather than saying 'may not scale', and check for missing timeouts, retries without backoff, and work done inside request handlers that belongs in a queue.",
    categories: ["performance"],
  },
  {
    id: "operations-and-rollout",
    name: "Operations & Rollout",
    focus:
      "Assume the deploy goes wrong at 2am. Is there a flag or kill switch, is the rollback a real step or a hope, and does the plan order deploys so old code never meets a new schema (expand → migrate → contract)? " +
      "Look for new env vars with no documented source, config that differs between local/preview/prod, cron or webhook registrations that must happen out-of-band, cost caps on paid APIs, and the absence of a log line or metric that would tell you the feature is failing. " +
      "Every finding should say what the on-call engineer would see and what they could do about it.",
    categories: ["operations"],
  },
  {
    id: "product-and-user",
    name: "Product & User",
    focus:
      "Read the plan as the person who has to use the result. Identify the user-visible states the plan does not design: loading, empty, partial failure, permission denied, stale data, and 'the thing I just did is not reflected yet'. " +
      "Challenge scope creep and the opposite — a shipped half-feature with no path to the second half — and check that error messages, copy, and defaults match what a real user would expect rather than what the code finds convenient. " +
      "Flag any behaviour change that existing users will notice without being told.",
    categories: ["product"],
  },
];

export interface LensModel {
  id: string;
  family: string;
  tier?: string;
}

/**
 * Deterministic lens assignment. Models are sorted by family then id and
 * walked round-robin over the lenses; because same-family models are
 * contiguous after the sort, a family only repeats a lens when it has more
 * members than there are lenses. The explicit skip below covers the wrap-around
 * case so two same-family models never share a lens when any lens is free.
 */
export function assignLenses(models: LensModel[], lenses: ReviewLens[] = REVIEW_LENSES): Map<string, ReviewLens> {
  const assignments = new Map<string, ReviewLens>();
  if (lenses.length === 0 || models.length === 0) return assignments;

  const ordered = [...models].sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
  const usedByFamily = new Map<string, Set<string>>();

  ordered.forEach((model, i) => {
    const used = usedByFamily.get(model.family) ?? new Set<string>();
    usedByFamily.set(model.family, used);

    let choice = lenses[i % lenses.length];
    for (let offset = 0; offset < lenses.length; offset++) {
      const candidate = lenses[(i + offset) % lenses.length];
      if (!used.has(candidate.id)) {
        choice = candidate;
        break;
      }
    }
    used.add(choice.id);
    assignments.set(model.id, choice);
  });

  return assignments;
}

/**
 * Appends a clearly delimited lens section to the base prompt. The base prompt
 * is left untouched so evidence/citation rules defined there still apply.
 */
export function lensPrompt(basePrompt: string, lens: ReviewLens): string {
  const categories = lens.categories.map((c) => `"${c}"`).join(", ");
  return [
    basePrompt.trimEnd(),
    "",
    `==== YOUR LENS: ${lens.name} (${lens.id}) ====`,
    lens.focus,
    "",
    `Spend most of your effort on this lens and file its findings under the ${lens.categories.length === 1 ? "category" : "categories"} ${categories}. ` +
      "Other council members cover the other lenses, so do not pad your report with generic observations outside it — " +
      "but if you notice something critical or high severity outside your lens, report it anyway under the category that fits.",
    "==== END LENS ====",
  ].join("\n");
}

/** Lens id → number of models assigned to it. Lenses with zero models are omitted. */
export function lensCoverage(assignments: Map<string, ReviewLens>): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const lens of assignments.values()) {
    coverage[lens.id] = (coverage[lens.id] ?? 0) + 1;
  }
  return coverage;
}
