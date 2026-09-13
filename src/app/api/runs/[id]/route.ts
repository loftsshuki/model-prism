import { NextRequest, NextResponse } from "next/server";
import { getRun, saveRunCheckpoint } from "@/lib/db";
import { requireAdminToken, runOwner } from "@/lib/api-auth";
import { CheckpointSchema, type RunCheckpoint } from "@/lib/run-checkpoint";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;
  const owner = runOwner(req);
  if (!owner) return NextResponse.json({ error: "Connect your OpenRouter key to enable private cloud checkpoints" }, { status: 401 });
  const { id } = await params;
  const body = await req.text();
  if (body.length > 12_000_000) return NextResponse.json({ error: "Checkpoint too large" }, { status: 413 });
  try {
    const parsed = CheckpointSchema.safeParse(JSON.parse(body));
    if (!parsed.success || parsed.data.id !== id) return NextResponse.json({ error: "Invalid checkpoint" }, { status: 400 });
    await saveRunCheckpoint(parsed.data as unknown as RunCheckpoint, owner);
    return NextResponse.json({ saved: true, revision: parsed.data.revision });
  } catch (error) {
    return NextResponse.json({ error: "Unable to save checkpoint" }, { status: error instanceof Error && error.message === "RUN_CONFLICT" ? 409 : 503 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const run = await getRun(id, runOwner(req));

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json({ run }, { headers: { "Cache-Control": "private, no-store" } });
}
