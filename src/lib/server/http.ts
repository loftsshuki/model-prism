import { NextResponse } from "next/server";
import { BudgetExceededError } from "../run-budget";
import { ReviewConflict } from "./background-store";

export function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
export function reviewError(error: unknown) {
  if (error instanceof ReviewConflict || error instanceof BudgetExceededError) return privateJson({ error: error.message }, 409);
  return privateJson({ error: "The review service is temporarily unavailable. Your saved progress is retained." }, 503);
}
export async function limitedJson(req: Request, maxBytes = 4_000_000): Promise<unknown> {
  if (Number(req.headers.get("content-length")) > maxBytes) throw new Error("Body exceeds the request limit");
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error("Body exceeds the request limit"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
