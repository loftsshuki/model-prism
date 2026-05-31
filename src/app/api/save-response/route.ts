import { NextRequest, NextResponse } from "next/server";
import { saveResponse, updateRunCost } from "@/lib/db";
import { requireAdminToken } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const { runId, model, modelName, family, response, error, timeMs, inputTokens, outputTokens, cost } = await req.json();

  if (!runId || !model) {
    return NextResponse.json({ error: "runId and model required" }, { status: 400 });
  }

  await saveResponse(
    runId,
    model,
    modelName ?? model,
    family ?? "unknown",
    response ?? null,
    error ?? null,
    timeMs ?? null,
    inputTokens ?? null,
    outputTokens ?? null,
    cost ?? null
  );

  // Update total cost if cost was provided
  if (cost) {
    await updateRunCost(runId, cost);
  }

  return NextResponse.json({ ok: true });
}
