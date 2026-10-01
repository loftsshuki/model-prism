import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";
import { z } from "zod";
import { getRun, getPlanStatus, savePlanStatus } from "@/lib/db";
import { PLAN_APPROVAL_STATUSES } from "@/lib/plan-status";

const statusIds = PLAN_APPROVAL_STATUSES.map(item => item.id) as [string, ...string[]];
const SaveInput = z.object({ runId: z.string().min(1).max(200), status: z.enum(statusIds), approvedAt: z.string().datetime().nullable().optional() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const runId = req.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "Missing runId" }, { status: 400 });

  try {
    if (!await getRun(runId, await requestOwner(req))) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    const row = await getPlanStatus(runId);
    return NextResponse.json({ status: row?.status ?? "council-reviewed", approvedAt: row?.approved_at ?? null });
  } catch (error) {
    console.error("[plan-status] load failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to load status" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req) ?? sameOrigin(req);
  if (unauthorized) return unauthorized;

  const parsed = SaveInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Valid runId and status required" }, { status: 400 });
  const { runId, status, approvedAt } = parsed.data;

  try {
    if (!await getRun(runId, await requestOwner(req))) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    await savePlanStatus(runId, status, approvedAt ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[plan-status] save failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to save status" }, { status: 500 });
  }
}
