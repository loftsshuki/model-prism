import { NextRequest, NextResponse } from "next/server";

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
