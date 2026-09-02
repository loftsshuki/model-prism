import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time comparison: hash both sides to equal length first so
// timingSafeEqual never throws on a length mismatch and leaks nothing about it.
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

let warnedOpen = false;

/**
 * Returns a 401 response when MODEL_PRISM_ADMIN_TOKEN is set and the request does
 * not carry it; null when the request may proceed.
 *
 * Fail-open by design for local use: with no token configured every route is open.
 * That is fine on localhost and dangerous on a public deployment, so it is logged
 * once per instance in production.
 */
export function requireAdminToken(req: NextRequest) {
  const expected = process.env.MODEL_PRISM_ADMIN_TOKEN;
  if (!expected) {
    if (!warnedOpen && process.env.NODE_ENV === "production") {
      warnedOpen = true;
      console.warn("[model-prism] MODEL_PRISM_ADMIN_TOKEN is not set: history, telemetry and save routes are publicly accessible.");
    }
    return null;
  }

  const provided = req.headers.get("x-model-prism-token") || "";
  if (provided && tokensMatch(provided, expected)) return null;

  return NextResponse.json(
    { error: "Unauthorized. Set the Model Prism admin token in Settings." },
    { status: 401 }
  );
}
