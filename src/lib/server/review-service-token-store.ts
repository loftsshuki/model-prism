import { createHash, randomBytes, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { initDb } from "../db";

export const REVIEW_SERVICE_SCOPES = ["reviews:start", "reviews:read", "reviews:stop"] as const;
export type ReviewServiceScope = typeof REVIEW_SERVICE_SCOPES[number];

const ownerPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^mp_svc_[A-Za-z0-9_-]{43}$/;
const tokenIdPattern = /^svc_[0-9a-f-]{36}$/;

function client() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  return neon(url);
}

async function ensureTable() {
  await initDb();
  const sql = client();
  await sql`CREATE TABLE IF NOT EXISTS review_service_tokens (
    token_id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    scopes JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  )`;
  await sql`CREATE INDEX IF NOT EXISTS review_service_tokens_owner
    ON review_service_tokens (owner_key, created_at DESC)`;
}

function checkOwner(owner: string) {
  if (!ownerPattern.test(owner)) throw new Error("Invalid account identity");
}

function checkTokenId(tokenId: string) {
  if (!tokenIdPattern.test(tokenId)) throw new Error("Invalid service token identity");
}

function normalizeScopes(scopes: readonly string[]): ReviewServiceScope[] {
  const unique = [...new Set(scopes)];
  if (!unique.length || unique.some(scope => !REVIEW_SERVICE_SCOPES.includes(scope as ReviewServiceScope))) {
    throw new Error("Invalid Review Fabric service-token scope");
  }
  return unique as ReviewServiceScope[];
}

function parseScopes(value: unknown): ReviewServiceScope[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Invalid stored service-token scopes");
  return normalizeScopes(parsed.map(String));
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createReviewServiceToken(
  owner: string,
  label: string,
  scopes: readonly string[] = REVIEW_SERVICE_SCOPES,
) {
  checkOwner(owner);
  const cleanLabel = label.trim();
  if (!cleanLabel || cleanLabel.length > 100) throw new Error("Service token label must be 1-100 characters");
  const normalizedScopes = normalizeScopes(scopes);
  await ensureTable();
  const sql = client();
  const count = await sql`SELECT COUNT(*)::int AS count FROM review_service_tokens
    WHERE owner_key=${owner} AND revoked_at IS NULL`;
  if (Number(count[0]?.count ?? 0) >= 10) throw new Error("Revoke an existing service token before creating another");

  const tokenId = `svc_${randomUUID()}`;
  const token = `mp_svc_${randomBytes(32).toString("base64url")}`;
  await sql`INSERT INTO review_service_tokens (token_id,owner_key,token_hash,label,scopes)
    VALUES (${tokenId},${owner},${tokenHash(token)},${cleanLabel},${JSON.stringify(normalizedScopes)}::jsonb)`;

  return {
    tokenId,
    token,
    label: cleanLabel,
    scopes: normalizedScopes,
    createdAt: new Date().toISOString(),
  };
}

export async function listReviewServiceTokens(owner: string) {
  checkOwner(owner);
  await ensureTable();
  const sql = client();
  const rows = await sql`SELECT token_id,label,scopes,created_at,last_used_at
    FROM review_service_tokens
    WHERE owner_key=${owner} AND revoked_at IS NULL
    ORDER BY created_at DESC`;
  return rows.map(row => ({
    tokenId: String(row.token_id),
    label: String(row.label),
    scopes: parseScopes(row.scopes),
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
  }));
}

export async function revokeReviewServiceToken(owner: string, tokenId: string) {
  checkOwner(owner);
  checkTokenId(tokenId);
  await ensureTable();
  const sql = client();
  const rows = await sql`UPDATE review_service_tokens SET revoked_at=NOW()
    WHERE owner_key=${owner} AND token_id=${tokenId} AND revoked_at IS NULL
    RETURNING token_id`;
  if (!rows.length) throw new Error("Service token not found");
}

export async function authenticateReviewServiceToken(token: string) {
  if (!tokenPattern.test(token)) return null;
  await ensureTable();
  const sql = client();
  const rows = await sql`SELECT token_id,owner_key,label,scopes
    FROM review_service_tokens
    WHERE token_hash=${tokenHash(token)} AND revoked_at IS NULL`;
  if (!rows.length) return null;
  const row = rows[0];
  const owner = String(row.owner_key);
  checkOwner(owner);
  const scopes = parseScopes(row.scopes);
  await sql`UPDATE review_service_tokens SET last_used_at=NOW() WHERE token_id=${String(row.token_id)}`;
  return {
    tokenId: String(row.token_id),
    owner,
    label: String(row.label),
    scopes,
  };
}

export function bearerReviewServiceToken(header: string | null) {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(mp_svc_[A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
}

export function serviceTokenHasScope(scopes: readonly ReviewServiceScope[], required: ReviewServiceScope) {
  return scopes.includes(required);
}