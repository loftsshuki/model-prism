import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchModelCatalog, COUNCIL_MAX_TOKENS } from "@/lib/model-catalog";
import { fanOut } from "@/lib/fan-out";
import { RunBudget } from "@/lib/run-budget";
import { requireAdminToken } from "@/lib/api-auth";

export const maxDuration = 60;
const Input = z.object({ model: z.string(), content: z.string().min(1).max(2_000_000), prompt: z.string().min(1).max(100_000), apiKey: z.string().min(1), maxTokens: z.number().int().positive().max(65536).default(COUNCIL_MAX_TOKENS), maxCost: z.number().positive().default(2) });
export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req); if (unauthorized) return unauthorized;
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Valid model, content, prompt, and OpenRouter key required" }, { status: 400 });
  const input = parsed.data;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(55000)]);
  try {
    const models = await fetchModelCatalog(signal);
    const model = models.find((item) => item.id === input.model);
    if (!model) return NextResponse.json({ error: "Text model unavailable" }, { status: 404 });
    const [result] = await fanOut({ ...input, models: [model], catalog: models, runId: null, signal, budget: new RunBudget(input.maxCost), isAborted: () => signal.aborted, onUpdate: () => {} });
    return NextResponse.json(result, { status: result.status === "complete" ? 200 : result.status === "incomplete" ? 422 : signal.aborted ? 504 : 502 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invocation failed" }, { status: 502 }); }
}
