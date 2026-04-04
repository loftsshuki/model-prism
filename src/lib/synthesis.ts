import { z } from "zod";

export const SynthesisSchema = z.object({
  consensus: z.array(
    z.object({
      point: z.string().describe("A specific point most models agree on"),
      supportingModels: z.array(z.string()).describe("Model IDs that support this point"),
      strength: z.enum(["strong", "moderate", "weak"]).describe("How strong the agreement is"),
    })
  ).describe("Points that 60%+ of distinct model architectures agree on"),

  uniqueInsights: z.array(
    z.object({
      model: z.string().describe("The model that surfaced this insight"),
      insight: z.string().describe("The unique insight"),
      significance: z.enum(["high", "medium", "low"]).describe("How significant this insight is"),
    })
  ).describe("Valuable insights raised by only 1-2 models"),

  disagreements: z.array(
    z.object({
      topic: z.string().describe("The topic of disagreement"),
      positions: z.array(
        z.object({
          models: z.array(z.string()).describe("Models holding this position"),
          position: z.string().describe("The position taken"),
        })
      ),
    })
  ).describe("Topics where models actively contradict each other"),

  blindSpots: z.array(z.string()).describe("Aspects of the prompt that most models ignored or underexplored"),

  themeMatrix: z.array(
    z.object({
      theme: z.string().describe("A major theme or topic from the analysis"),
      scores: z.record(z.string(), z.number().min(0).max(3)).describe("Map of model name to coverage score: 0=not mentioned, 1=briefly mentioned, 2=discussed, 3=deeply analyzed"),
    })
  ).describe("For each major theme identified across all responses, rate how thoroughly each model covered it (0-3). Use model names (not IDs) as keys. Include 4-8 themes."),
});

export type SynthesisResult = z.infer<typeof SynthesisSchema>;

export function buildSynthesisPrompt(
  content: string,
  analysisPrompt: string,
  responses: Array<{ model: string; modelName: string; family: string; response: string }>
): string {
  const truncatedContent = content.length > 2000 ? content.slice(0, 2000) + "..." : content;

  const responsesXml = responses
    .map(
      (r) =>
        `<model_response id="${r.model}" name="${r.modelName}" architecture="${r.family}">\n${r.response}\n</model_response>`
    )
    .join("\n\n");

  const families = [...new Set(responses.map((r) => r.family))];

  return `You are analyzing responses from ${responses.length} AI models (across ${families.length} distinct architectures: ${families.join(", ")}) to the same prompt.

<original_content truncated="true">
${truncatedContent}
</original_content>

<analysis_prompt>
${analysisPrompt}
</analysis_prompt>

<responses>
${responsesXml}
</responses>

IMPORTANT: When calculating consensus, weight by distinct base architecture — multiple variants of the same model family (e.g., 3 Llama models) count as 1 vote, not 3.

Identify what's genuinely interesting: where do models converge? What did only one model notice that others missed? Where do they flatly disagree? What did the prompt ask about that models mostly skipped?

For the themeMatrix: identify 4-8 major themes across all responses. For each theme, score every model 0-3 on how thoroughly they covered it (0=not mentioned, 1=briefly mentioned, 2=discussed, 3=deeply analyzed). Use model display names as keys.`;
}
