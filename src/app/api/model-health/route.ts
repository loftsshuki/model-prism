import { readFreshness } from "@/lib/server/freshness-store";

export async function GET() {
  try { return Response.json({ report: await readFreshness() }, { headers: { "Cache-Control": "public, max-age=60" } }); }
  catch { return Response.json({ report: null, error: "Scheduled check status is temporarily unavailable" }, { status: 503 }); }
}
