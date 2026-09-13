import { NextRequest, NextResponse } from "next/server";
import { saveSynthesis, updateRunCost } from "@/lib/db";
import { getRun } from "@/lib/db";
import { requireAdminToken, runOwner } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const { runId, result, modelUsed } = await req.json();

  if (!runId || !result || !modelUsed) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    if (!await getRun(runId, runOwner(req))) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    await saveSynthesis(runId, result, modelUsed);
    await updateRunCost(runId, 0);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Save synthesis error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
