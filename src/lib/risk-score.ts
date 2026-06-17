// ═══════════════════════════════════════════════════════════════════════════
// Model Prism — structured risk scorer (B1 / B5)
//
// Emits a STRUCTURED 0–100 risk score for a plan, computed BEFORE the council
// launches so Phase 4 (agentic-member selection) can gate on it. The sequence is
// explicit and enforced by the caller: (1) score → (2) verify → (3) council +
// Phase-4 gate read it. A parallel/after-the-fact scorer would leave the score
// unavailable at agentic-member selection time.
//
// Re: COUNCIL invocation the score is log-only / shadow until trusted. Re:
// AGENTIC-MEMBER selection it is LIVE (high tier → agentic members eligible).
//
// `build` and `irreversible` signals are defined CONCRETELY here (B1) because they
// gate the high-risk path. Pure + fully unit-testable: no I/O, no network.
// ═══════════════════════════════════════════════════════════════════════════

export type RiskTier = "low" | "medium" | "high";

export interface RiskSignal {
  name: string;
  weight: number;
  matched: boolean;
  detail?: string;
}

export interface RiskScore {
  score: number;            // 0–100 (clamped)
  tier: RiskTier;           // low <30, medium 30–64, high ≥65
  irreversible: boolean;    // any irreversible signal matched (B1)
  build: boolean;           // any build signal matched (B1)
  signals: RiskSignal[];    // every signal evaluated, for the structured log
}

// Tier cutoffs. High is the agentic-member gate.
export const RISK_TIER_MEDIUM = 30;
export const RISK_TIER_HIGH = 65;

// ── B1: irreversible signals ────────────────────────────────────────────────
// Touches migrations, destructive SQL, or RLS — a bad plan here is expensive or
// impossible to undo, so these carry the most weight.
const IRREVERSIBLE_SIGNALS: Array<{ name: string; weight: number; re: RegExp }> = [
  { name: "supabase-migration", weight: 40, re: /supabase[\/\\]migrations[\/\\]/i },
  { name: "destructive-sql", weight: 40, re: /\b(drop\s+(table|column|schema|database|policy)|truncate\s+table?|alter\s+table\s+[^\n;]*\bdrop\b)/i },
  { name: "rls-change", weight: 30, re: /\b(row[\s-]?level\s+security|enable\s+row\s+level|create\s+policy|drop\s+policy|alter\s+policy|using\s*\([^)]*auth\.)/i },
];

// ── B1: build signals ───────────────────────────────────────────────────────
// Touches build/runtime/CI config — wide blast radius across the whole repo.
const BUILD_SIGNALS: Array<{ name: string; weight: number; re: RegExp }> = [
  { name: "package-json", weight: 18, re: /\bpackage\.json\b/i },
  { name: "tsconfig", weight: 12, re: /\btsconfig[\w.-]*\.json\b/i },
  { name: "next-config", weight: 15, re: /\bnext\.config\.[mc]?[jt]s\b/i },
  { name: "ci-workflow", weight: 15, re: /\.github[\/\\]workflows[\/\\]/i },
  { name: "lockfile", weight: 10, re: /\b(package-lock\.json|pnpm-lock\.yaml|bun\.lock(b)?|yarn\.lock)\b/i },
];

// ── Domain signals (reuse the coordinator plan's tiering signals) ────────────
const DOMAIN_SIGNALS: Array<{ name: string; weight: number; re: RegExp }> = [
  { name: "auth", weight: 20, re: /\b(authentication|authorization|\bauth\b|login|session\s+token|jwt|oauth|password|credential)/i },
  { name: "api-route", weight: 12, re: /\b(api[\/\\]|route\.ts|endpoint|webhook|server\s+action)/i },
  { name: "schema", weight: 14, re: /\b(schema|migration|\btable\b|\bcolumn\b|foreign\s+key|index\s+on)/i },
  { name: "payments-pii", weight: 22, re: /\b(payment|stripe|billing|pii|ssn|credit\s+card|gdpr|ccpa|fair\s+housing)/i },
];

// Diff-size proxy. When a real diff isn't available (first save), plan length +
// referenced-file count stands in. Bigger surface = more that can go wrong.
function sizeSignal(planContent: string, referencedFileCount: number): RiskSignal {
  const kb = planContent.length / 1024;
  // 0 at tiny, saturating ~20 by ~40KB plan or ~12 referenced files.
  const weight = Math.min(20, Math.round(kb * 0.4 + referencedFileCount * 1.5));
  return { name: "surface-size", weight: 20, matched: weight > 0, detail: `${kb.toFixed(1)}KB plan, ${referencedFileCount} referenced files → +${weight}` };
}

function evalGroup(content: string, group: Array<{ name: string; weight: number; re: RegExp }>): RiskSignal[] {
  return group.map((s) => {
    const m = content.match(s.re);
    return { name: s.name, weight: s.weight, matched: !!m, detail: m ? `matched "${m[0].slice(0, 40)}"` : undefined };
  });
}

function tierFor(score: number): RiskTier {
  if (score >= RISK_TIER_HIGH) return "high";
  if (score >= RISK_TIER_MEDIUM) return "medium";
  return "low";
}

// Compute the structured risk score from plan content. `referencedFileCount` is the
// number of repo files the plan explicitly references (review-plan.ts already detects
// these); defaults to 0 so the scorer stays pure/standalone-callable.
export function computeRiskScore(planContent: string, referencedFileCount = 0): RiskScore {
  const irreversible = evalGroup(planContent, IRREVERSIBLE_SIGNALS);
  const build = evalGroup(planContent, BUILD_SIGNALS);
  const domain = evalGroup(planContent, DOMAIN_SIGNALS);
  const size = sizeSignal(planContent, referencedFileCount);

  const signals = [...irreversible, ...build, ...domain, size];
  // Each matched signal contributes its weight; size contributes its computed weight.
  const raw = signals.reduce((sum, s) => {
    if (s.name === "surface-size") return sum + Math.min(20, parseInt(s.detail?.match(/\+(\d+)/)?.[1] ?? "0", 10));
    return sum + (s.matched ? s.weight : 0);
  }, 0);
  const score = Math.max(0, Math.min(100, raw));

  return {
    score,
    tier: tierFor(score),
    irreversible: irreversible.some((s) => s.matched),
    build: build.some((s) => s.matched),
    signals,
  };
}

// One-line structured summary for the shadow log / frontmatter.
export function summarizeRisk(r: RiskScore): string {
  const hits = r.signals.filter((s) => s.matched).map((s) => s.name).join(",");
  return `score=${r.score} tier=${r.tier} irreversible=${r.irreversible} build=${r.build} signals=[${hits}]`;
}
