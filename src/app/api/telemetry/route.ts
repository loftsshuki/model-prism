import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireAdminToken } from "@/lib/api-auth";
import { serverError } from "@/lib/api-validate";
import { listRunTelemetry, saveRunTelemetry } from "@/lib/db";
import {
  aggregateModelValue,
  analyzeModelFailures,
  buildRunTelemetry,
  recommendRosterChanges,
  RunTelemetry,
} from "@/lib/telemetry";
import { ModelInfo, ModelResponse, SynthesisResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseTelemetryRows(rows: Array<{ record: unknown }>): RunTelemetry[] {
  const runs: RunTelemetry[] = [];
  for (const row of rows) {
    try {
      if (typeof row.record === "string") runs.push(JSON.parse(row.record) as RunTelemetry);
    } catch {
      // Skip corrupt rows rather than breaking the dashboard.
    }
  }
  return runs;
}

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  try {
    const runs = parseTelemetryRows(await listRunTelemetry());
    const leaderboard = aggregateModelValue(runs);
    return NextResponse.json({
      telemetryPath: "database:run_telemetry",
      runCount: runs.length,
      leaderboard,
      diagnostics: analyzeModelFailures(leaderboard),
      recommendations: recommendRosterChanges(leaderboard),
    });
  } catch (error) {
    return serverError("telemetry GET", error, "Failed to load telemetry");
  }
}

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  let body: {
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
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (!body.synthesis || !body.responses?.length || !body.usedModels?.length) {
    return NextResponse.json({ error: "Missing telemetry fields" }, { status: 400 });
  }

  const contentHash = createHash("sha256").update(body.content || "").digest("hex").slice(0, 16);
  let record: RunTelemetry;
  try {
    record = buildRunTelemetry({
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
  } catch (error) {
    // A malformed shape used to throw outside any try → unhandled 500 with a stack.
    console.error("[api] telemetry POST: could not build record:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Telemetry payload has an unexpected shape" }, { status: 400 });
  }

  try {
    await saveRunTelemetry(JSON.stringify(record));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return serverError("telemetry POST", error, "Failed to save telemetry");
  }
}
