import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";
import { getRun } from "@/lib/db";
import { listTrackedFindings, recordFindings, updateFinding } from "@/lib/server/finding-store";
import { limitedJson, privateJson, reviewError } from "@/lib/server/http";
import type { RunCheckpoint } from "@/lib/run-checkpoint";

const Decision = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{32}$/), state: z.enum(["open", "accepted", "dismissed", "fixed"]),
  dismissalReason: z.enum(["false_positive", "not_actionable", "duplicate", "other"]).optional(), note: z.string().max(2000).default("") });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireAdminToken(req); if (denied) return denied;
  const owner = await requestOwner(req);
  if (!owner) return privateJson({ error: "Private review access required" }, 401);
  try {
    const { id } = await params;
    const run = await getRun(id, owner);
    if (!run?.snapshot) return privateJson({ error: "Saved review not found" }, 404);
    const snapshot = run.snapshot as RunCheckpoint;
    if (!snapshot.background && snapshot.synthesis) await recordFindings(snapshot, owner);
    return privateJson({ findings: await listTrackedFindings(id, owner, snapshot.baselineRunId), baselineRunId: snapshot.baselineRunId });
  } catch (error) { return reviewError(error); }
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireAdminToken(req) ?? sameOrigin(req); if (denied) return denied;
  const owner = await requestOwner(req);
  if (!owner) return privateJson({ error: "Private review access required" }, 401);
  const parsed = Decision.safeParse(await limitedJson(req, 12000).catch(() => null));
  if (!parsed.success) return privateJson({ error: "Choose a valid finding decision" }, 400);
  try { await updateFinding({ ...parsed.data, runId: (await params).id }, owner); return privateJson({ saved: true }); }
  catch (error) { return reviewError(error); }
}
