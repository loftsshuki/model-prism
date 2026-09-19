import { NextRequest, NextResponse } from "next/server";
import { createRun, listRuns } from "@/lib/db";
import { requireAdminToken, requestOwner, sameOrigin } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const unauthorized = requireAdminToken(req) ?? sameOrigin(req);
  if (unauthorized) return unauthorized;

  const owner = await requestOwner(req);
  if (!owner) return NextResponse.json({ error: "Private review access required" }, { status: 401 });
  const { id, content, prompt, models, contextMetadata } = await req.json();

  if (!id || !content || !prompt || !models?.length) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  await createRun(id, content, prompt, models, contextMetadata, owner);
  return NextResponse.json({ id });
}

export async function GET(req: NextRequest) {
  const unauthorized = requireAdminToken(req);
  if (unauthorized) return unauthorized;

  const runs = await listRuns(await requestOwner(req));
  return NextResponse.json({ runs }, { headers: { "Cache-Control": "private, no-store" } });
}
