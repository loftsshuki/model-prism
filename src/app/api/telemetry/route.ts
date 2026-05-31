import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireAdminToken } from "@/lib/api-auth";
import {
  aggregateModelValue,
  analyzeModelFailures,
  appendRunTelemetry,
  buildRunTelemetry,
  loadTelemetry,
  recommendRosterChanges,
  TELEMETRY_PATH,
} from "@/lib/telemetry";
import { ModelInfo, ModelResponse, SynthesisResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const runs = loadTelemetry();
  const leaderboard = aggregateModelValue(runs);
  return NextResponse.json({
    telemetryPath: TELEMETRY_PATH,
    runCount: runs.length,
    leaderboard,
    diagnostics: analyzeModelFailures(leaderboard),
    recommendations: recommendRosterChanges(leaderboard),
  });
}

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const body = await req.json() as {
    content?: string;
    contextRepo?: string;
    durationSec?: number;
    plan?: string;
    responses?: ModelResponse[];
    roster?: string;
    synthesis?: SynthesisResult;
    synthesisModel?: string;
    usedModels?: ModelInfo[];
  };

  if (!body.synthesis || !body.responses?.length || !body.usedModels?.length) {
    return NextResponse.json({ error: "Missing telemetry fields" }, { status: 400 });
  }

  const contentHash = createHash("sha256").update(body.content || "").digest("hex").slice(0, 16);
  const record = buildRunTelemetry({
    ts: new Date().toISOString(),
    plan: body.plan || "web-run",
    contentHash,
    contextRepo: body.contextRepo || "none",
    roster: body.roster || "custom",
    synthesisModel: body.synthesisModel || "unknown",
    durationSec: Math.max(0, Math.round(body.durationSec || 0)),
    synthesis: body.synthesis,
    responses: body.responses,
    usedModels: body.usedModels,
  });

  appendRunTelemetry(record);
  return NextResponse.json({ ok: true });
}
