import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { synthesizeViaOpenRouter } from "@/lib/synthesis";
import { fetchModelCatalog, SYNTHESIS_IDS } from "@/lib/model-catalog";
import { RunBudget } from "@/lib/run-budget";
import { getRun, saveSynthesis, updateRunCost } from "@/lib/db";
import { requireAdminToken, runOwner } from "@/lib/api-auth";

export const maxDuration = 60;
const Input = z.object({ runId: z.string().optional(), content: z.string(), analysisPrompt: z.string(), openrouterKey: z.string().min(1), synthesisModel: z.enum(["sonnet", "opus", "fable"]).default("sonnet"), maxCost: z.number().positive().default(2), responses: z.array(z.object({ model: z.string(), modelName: z.string(), family: z.string(), response: z.string().min(1) })).min(2).max(100) });
export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req); if (unauthorized) return unauthorized;
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Supply openrouterKey and at least two completed responses. All synthesis now uses OpenRouter." }, { status: 400 });
  const input = parsed.data;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(55000)]);
  try {
    if (input.runId && !await getRun(input.runId, runOwner(req))) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    await fetchModelCatalog(signal);
    const modelId = SYNTHESIS_IDS[input.synthesisModel];
    const result = await synthesizeViaOpenRouter({ ...input, modelId, signal, budget: new RunBudget(input.maxCost) });
    if (input.runId) { await saveSynthesis(input.runId, JSON.stringify(result), modelId); await updateRunCost(input.runId, 0); }
    return NextResponse.json({ synthesis: result, model: modelId, usage: result.usage });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Synthesis failed" }, { status: signal.aborted ? 504 : 502 }); }
}
