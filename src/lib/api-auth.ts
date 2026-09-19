import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

export function runOwner(req: NextRequest): string | null {
  const token = req.headers.get("x-model-prism-owner") ?? "";
  return /^[a-f0-9]{64}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

// Kept separate from the legacy capability decoder so account sessions can own
// records without tying their identity to a provider credential.
export async function requestOwner(req: NextRequest): Promise<string | null> {
  return runOwner(req);
}

export function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  // Next may use its internal hostname in nextUrl behind a proxy. The Host
  // header identifies the origin the browser actually addressed.
  const host = req.headers.get("host");
  const protocol = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  let expected = req.nextUrl.origin;
  try { if (host && ["http", "https"].includes(protocol)) expected = new URL(`${protocol}://${host}`).origin; }
  catch { return NextResponse.json({ error: "Invalid request host" }, { status: 403 }); }
  if (origin && origin !== expected) return NextResponse.json({ error: "Request origin is not allowed" }, { status: 403 });
  if (req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Cross-site request is not allowed" }, { status: 403 });
  return null;
}

export function matchesSecret(provided: string, expected: string | undefined) {
  if (!expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAdminToken(req: NextRequest) {
  const expected = process.env.MODEL_PRISM_ADMIN_TOKEN;
  if (!expected) return null;

  const provided = req.headers.get("x-model-prism-token") || "";
  if (matchesSecret(provided, expected)) return null;

  return NextResponse.json(
    { error: "Unauthorized. Set the Model Prism admin token in Settings." },
    { status: 401 }
  );
}
