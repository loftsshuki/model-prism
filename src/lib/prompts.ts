export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

export const DEFAULT_TEMPLATES: PromptTemplate[] = [
  {
    id: "room-review",
    name: "Room Review Analysis",
    prompt:
      "Analyze this room/apartment review. Evaluate: design quality, accuracy of claims, details the reviewer missed, improvement suggestions, and whether the pricing seems justified. Be specific and critical.",
  },
  {
    id: "copy-critique",
    name: "Copy Critique",
    prompt:
      "Critique this copy. Evaluate: tone and voice consistency, clarity, persuasiveness, target audience fit, CTA effectiveness, and any cliches or weak phrasing. Suggest specific rewrites for the weakest parts.",
  },
  {
    id: "strategy-test",
    name: "Strategy Pressure Test",
    prompt:
      "Pressure-test this strategy. Identify: unstated assumptions, biggest risks, missing perspectives, competitive blind spots, and what would need to be true for this to succeed. Be adversarial.",
  },
  {
    id: "code-review",
    name: "Code Review",
    prompt:
      "Review this code. Check for: bugs, security vulnerabilities, performance issues, readability problems, and architectural concerns. Suggest specific fixes with code examples.",
  },
  {
    id: "plan-review",
    name: "Plan Teardown",
    prompt:
      `You are a brutally honest senior advisor reviewing a plan, spec, or proposal. Your job is to make this plan bulletproof before execution begins. Analyze it across five dimensions:

1. FATAL FLAWS — Architecture contradictions, physical impossibilities, or assumptions that will blow up at runtime/execution. These are ship-stoppers. For each one, explain the detonation scenario (what breaks and when) and provide a specific defusal (the exact fix).

2. LANDMINES — Hidden dependencies, API/integration gotchas, scaling traps, regulatory risks, or logic errors that won't surface until you're deep into execution. Things that work in a demo but fail in production. For each one, explain when it detonates and how to defuse it.

3. GAPS — Missing pieces the plan doesn't address: error handling, edge cases, migration paths, rollback strategies, monitoring, cost modeling, user flows that dead-end. Don't just list what's missing — explain why it matters and what specifically to add.

4. TURBOCHARGES — Opportunities the plan is leaving on the table. Things that would 2-5x the impact with modest additional effort: better abstractions, smarter sequencing, features that unlock network effects, architectural choices that make future work dramatically easier. Be specific about the ROI of each.

5. EXECUTION RISKS — Sequencing problems, dependency chains that create bottlenecks, scope creep vectors, areas where the plan is under-specified enough that two engineers would build it differently. Suggest the exact order of operations and decision points.

For each item, be specific enough that someone could act on your feedback without asking follow-up questions. Reference specific sections of the plan. No vague "consider scalability" — say exactly what will break and exactly how to fix it.`,
  },
  {
    id: "general",
    name: "General Analysis",
    prompt:
      "Analyze the following content thoroughly. Identify key themes, strengths, weaknesses, and provide actionable recommendations. Be specific and cite details from the content.",
  },
];
