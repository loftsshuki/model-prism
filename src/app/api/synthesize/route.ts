import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { SynthesisSchema, buildSynthesisPrompt } from "@/lib/synthesis";
import { saveSynthesis } from "@/lib/db";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { runId, content, analysisPrompt, responses, synthesisModel, anthropicKey } = await req.json();

  if (!responses?.length) {
    return NextResponse.json({ error: "No responses to synthesize" }, { status: 400 });
  }

  if (!anthropicKey) {
    return NextResponse.json({ error: "Anthropic API key required for synthesis" }, { status: 401 });
  }

  const modelId = synthesisModel === "opus"
    ? "claude-opus-4-6" as const
    : "claude-sonnet-4-6" as const;

  const prompt = buildSynthesisPrompt(content, analysisPrompt, responses);

  try {
    const provider = createAnthropic({ apiKey: anthropicKey });
    const result = await generateObject({
      model: provider(modelId),
      schema: SynthesisSchema,
      prompt,
    });

    // Save to DB
    if (runId) {
      await saveSynthesis(runId, JSON.stringify(result.object), modelId);
    }

    return NextResponse.json({
      synthesis: result.object,
      model: modelId,
      usage: result.usage,
    });
  } catch (error) {
    console.error("Synthesis error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Synthesis failed" },
      { status: 500 }
    );
  }
}
