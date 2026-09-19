import { matchesSecret } from "@/lib/api-auth";
import { checkAndSaveFreshness } from "@/lib/server/freshness-store";
import { recoverAbandonedReviews } from "@/lib/server/background-store";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(req: Request) {
  if (!matchesSecret(req.headers.get("authorization") ?? "", process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : undefined)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const report = await checkAndSaveFreshness();
  const recovered = await recoverAbandonedReviews();
  return Response.json({ ...report, recovered }, { status: report.status === "failed" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
