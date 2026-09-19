import { NextRequest, NextResponse } from "next/server";
import { getRun, saveResponse, updateRunCost } from "@/lib/db";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req) ?? sameOrigin(req);
  if (unauthorized) return unauthorized;

  const { runId, model, modelName, family, response, error, timeMs, inputTokens, outputTokens, cost } = await req.json();

  if (!runId || !model) {
    return NextResponse.json({ error: "runId and model required" }, { status: 400 });
  }

  const run = await getRun(runId, await requestOwner(req));
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.snapshot?.background) return NextResponse.json({ error: "Background reviews are saved by the worker" }, { status: 409 });
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
