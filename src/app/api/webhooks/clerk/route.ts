import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { accountOwner } from "@/lib/account-identity";
import { revocationTarget, revokeAccountAccess } from "@/lib/server/account-revocation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) return NextResponse.json({ error: "Clerk webhooks are not configured" }, { status: 503 });
  let event;
  try { event = await verifyWebhook(req); }
  catch { return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 }); }

  const userId = revocationTarget(event as unknown as { type: string; data: Record<string, unknown> });
  if (!userId) return NextResponse.json({ ok: true, ignored: event.type });
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: true, ignored: "no database" });
  try {
    const result = await revokeAccountAccess(accountOwner(userId));
    console.info(`[clerk webhook] ${event.type}: revoked ${result.revokedTokens} service token(s), stopped ${result.stoppedRuns} review(s)`);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // 5xx makes Clerk (Svix) retry the delivery; the operations are idempotent.
    console.error("[clerk webhook] revocation failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Revocation failed; the delivery will be retried" }, { status: 503 });
  }
}
