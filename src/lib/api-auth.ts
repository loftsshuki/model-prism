import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export function runOwner(req: NextRequest): string | null {
  const token = req.headers.get("x-model-prism-owner") ?? "";
  return /^[a-f0-9]{64}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

export function requireAdminToken(req: NextRequest) {
  const expected = process.env.MODEL_PRISM_ADMIN_TOKEN;
  if (!expected) return null;

  const provided = req.headers.get("x-model-prism-token") || "";
  if (provided === expected) return null;

  return NextResponse.json(
    { error: "Unauthorized. Set the Model Prism admin token in Settings." },
    { status: 401 }
  );
}
