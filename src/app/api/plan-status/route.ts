import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/api-auth";
import { getPlanStatus, savePlanStatus } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const runId = req.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "Missing runId" }, { status: 400 });

  try {
    const row = await getPlanStatus(runId);
    return NextResponse.json({ status: row?.status ?? "council-reviewed", approvedAt: row?.approved_at ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load status" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const { runId, status, approvedAt } = await req.json();
  if (!runId || !status) return NextResponse.json({ error: "Missing runId or status" }, { status: 400 });

  try {
    await savePlanStatus(runId, status, approvedAt ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save status" }, { status: 500 });
  }
}
