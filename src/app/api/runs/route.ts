import { NextRequest, NextResponse } from "next/server";
import { createRun, listRuns } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { id, content, prompt, models, contextMetadata } = await req.json();

  if (!id || !content || !prompt || !models?.length) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  await createRun(id, content, prompt, models, contextMetadata);
  return NextResponse.json({ id });
}

export async function GET() {
  const runs = await listRuns();
  return NextResponse.json({ runs });
}
