import { NextRequest, NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { requireAdminToken } from "./api-auth";

// Authorization and self-scheduling for the review-job worker (POST|GET /api/jobs/work).

function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The worker accepts EITHER the admin token (dashboard, manual curl) OR the cron
 * secret (Vercel cron sends `Authorization: Bearer $CRON_SECRET`; the self-kick
 * sends `x-cron-secret`). Falls back to the admin-token gate, which is fail-open
 * only when no admin token is configured (local use).
 */
export function authorizeWorker(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const provided = req.headers.get("x-cron-secret") || bearer;
    if (provided && secretsMatch(provided, secret)) return null;
  }
  return requireAdminToken(req);
}

/**
 * Where the worker lives. Deliberately NOT read from Host/X-Forwarded-Host: the kick
 * carries the admin token and cron secret, so a spoofed header must not be able to
 * redirect them. Set MODEL_PRISM_BASE_URL on non-Vercel deployments.
 */
export function workerBaseUrl(req: NextRequest): string {
  const explicit = process.env.MODEL_PRISM_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return req.nextUrl.origin;
}

/** How long the kick waits for the worker to acknowledge before letting go (the worker keeps running). */
const KICK_WAIT_MS = 2_000;

/**
 * Fire-and-forget a worker invocation so a run progresses immediately instead of
 * waiting for the next cron tick. Runs after the response is sent (`after`), and
 * deliberately does not wait for the worker to finish — the invoked function keeps
 * running after the client aborts. Any failure is swallowed: the cron is the safety net.
 */
export function kickWorker(req: NextRequest): void {
  const url = `${workerBaseUrl(req)}/api/jobs/work`;
  const headers: Record<string, string> = {};
  if (process.env.MODEL_PRISM_ADMIN_TOKEN) headers["x-model-prism-token"] = process.env.MODEL_PRISM_ADMIN_TOKEN;
  if (process.env.CRON_SECRET) headers["x-cron-secret"] = process.env.CRON_SECRET;

  const kick = async () => {
    try {
      await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(KICK_WAIT_MS) });
    } catch {
      // Timeout (expected: the worker outlives the wait) or unreachable origin — cron will pick it up.
    }
  };

  try {
    after(kick);
  } catch {
    // Outside a request scope (should not happen in a route handler): kick inline.
    void kick();
  }
}
