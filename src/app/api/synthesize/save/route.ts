import { NextRequest, NextResponse } from "next/server";
import { getRun, saveSynthesis, updateRunCost } from "@/lib/db";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req) ?? sameOrigin(req);
  if (unauthorized) return unauthorized;

  const { runId, result, modelUsed } = await req.json();

  if (!runId || !result || !modelUsed) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const run = await getRun(runId, await requestOwner(req));
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    if (run.snapshot?.background) return NextResponse.json({ error: "Background reviews are saved by the worker" }, { status: 409 });
    await saveSynthesis(runId, result, modelUsed);
    await updateRunCost(runId, 0);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Save synthesis error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
