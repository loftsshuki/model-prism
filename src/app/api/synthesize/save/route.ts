import { NextRequest, NextResponse } from "next/server";
import { saveSynthesis } from "@/lib/db";
import { requireAdminToken } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const { runId, result, modelUsed } = await req.json();

  if (!runId || !result || !modelUsed) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    await saveSynthesis(runId, result, modelUsed);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Save synthesis error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
