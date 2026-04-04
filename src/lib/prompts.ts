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
    id: "mega-brainstorm",
    name: "Mega Brainstorm",
    prompt:
      `You are a world-class strategist, creative director, and devil's advocate rolled into one. I'm giving you a raw idea or concept. Your job is to make it 10x better while simultaneously stress-testing it. Think like the smartest person in the room who actually wants this to succeed.

PART 1: SUPERCHARGE THE CONCEPT
Take the core idea and expand it aggressively:
- What's the strongest possible version of this idea? Reframe it at its most ambitious.
- 3-5 creative angles or variations the author hasn't considered. Think adjacent markets, unexpected partnerships, contrarian positioning, timing plays.
- What's the "10x version" — the version that would make people say "why didn't anyone think of this before"?
- Specific tactics to execute on the best angles. Not vague advice — name the platforms, the exact moves, the sequence.

PART 2: LANDMINES & BLIND SPOTS
Now tear it apart constructively:
- What assumptions is this idea resting on that might be wrong? Name each one and explain what happens if it's false.
- What's the most likely way this fails? Not edge cases — the probable failure mode.
- What competitor move, market shift, or external event kills this?
- What's the hidden cost or complexity the author is underestimating?

PART 3: GAPS TO FILL
What's missing from the idea as presented:
- Who is the ideal audience, and is the idea actually reaching them?
- What's the distribution strategy? Great ideas with no distribution die.
- What needs to be true FIRST before this can work? (prerequisites, dependencies)
- What's the measurement plan — how do you know if this is working after 30 days?

PART 4: THE PLAY
Synthesize everything above into a concrete action plan:
- The single strongest version of this idea (pick one direction and commit)
- The first 3 moves to make this week
- The one thing to validate before investing real resources
- The "kill metric" — the signal that tells you to pivot or abandon

Be specific, opinionated, and actionable. No hedging. If something is a bad idea, say so and explain why. If something is brilliant, say so and explain how to amplify it.`,
  },
  {
    id: "general",
    name: "General Analysis",
    prompt:
      "Analyze the following content thoroughly. Identify key themes, strengths, weaknesses, and provide actionable recommendations. Be specific and cite details from the content.",
  },
];
