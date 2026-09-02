import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { idField, parseBody, serverError } from "@/lib/api-validate";
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
    return serverError("plan status GET", error, "Failed to load status");
  }
}

const PLAN_STATUSES = ["council-reviewed", "needs-changes", "founder-approved", "ready", "executed"] as const;
const PlanStatusBody = z.object({
  runId: idField,
  status: z.enum(PLAN_STATUSES),
  approvedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await parseBody(req, PlanStatusBody);
  if (!body.ok) return body.response;
  const { runId, status, approvedAt } = body.data;

  try {
    await savePlanStatus(runId, status, approvedAt ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return serverError("plan status POST", error, "Failed to save status");
  }
}
