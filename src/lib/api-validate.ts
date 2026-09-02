import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Shared request-body validation for the API routes. Every POST used to call
// `req.json()` unguarded (malformed JSON → 500) and trust field types (a string
// `cost` reached Postgres as a type error). Parse once, reject with a 400 that
// names the field, and hand the route a typed body.
export async function parseBody<T extends z.ZodTypeAny>(
  req: NextRequest,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
    return { ok: false, response: NextResponse.json({ error: `Invalid request${where}: ${first?.message ?? "validation failed"}` }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}

/** Log the real error server-side; return a generic message so SQL/env details never reach the client. */
export function serverError(context: string, error: unknown, message = "Internal error"): NextResponse {
  console.error(`[api] ${context}:`, error instanceof Error ? error.message : error);
  return NextResponse.json({ error: message }, { status: 500 });
}

// Generous upper bounds: enough for any real plan/diff, small enough to stop a
// runaway client from filling the database.
export const MAX_TEXT = 2_000_000;
export const idField = z.string().min(1).max(200);
export const textField = z.string().max(MAX_TEXT);
