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
    id: "general",
    name: "General Analysis",
    prompt:
      "Analyze the following content thoroughly. Identify key themes, strengths, weaknesses, and provide actionable recommendations. Be specific and cite details from the content.",
  },
];
