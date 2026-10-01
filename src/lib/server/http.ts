import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { BudgetExceededError } from "../run-budget";
import { ReviewConflict } from "./background-store";

export function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
/**
 * 4xx only for permanent problems a retry cannot fix; 503 only for transient ones.
 * Everything that used to fall through to 503 made service callers retry forever.
 */
export function reviewError(error: unknown) {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return privateJson({ error: `Invalid request${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "validation failed"}` }, 400);
  }
  if (error instanceof ReviewConflict) return privateJson({ error: error.message }, error.status);
  if (error instanceof BudgetExceededError) return privateJson({ error: error.message }, 409);
  console.error("[review] unexpected error:", error instanceof Error ? error.message : error);
  return privateJson({ error: "The review service is temporarily unavailable. Your saved progress is retained." }, 503);
}

/** Message safe to return to an agent/tool caller: validation and permanent errors pass through, internals do not. */
export function publicErrorMessage(error: unknown) {
  if (error instanceof ZodError) return `Invalid arguments: ${error.issues[0]?.path.join(".") || "input"} ${error.issues[0]?.message ?? ""}`.trim();
  if (error instanceof ReviewConflict || error instanceof BudgetExceededError) return error.message;
  console.error("[review] unexpected tool error:", error instanceof Error ? error.message : error);
  return "Model Prism could not complete this request right now. Saved reviews and spending are retained; try again shortly.";
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
