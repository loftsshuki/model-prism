import { neon } from "@neondatabase/serverless";
import { initDb } from "../db";
import { decryptCredential, encryptCredential } from "./credentials";

const ownerPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^sk-or-[a-zA-Z0-9_-]+$/;

function client() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  return neon(url);
}

async function ensureTable() {
  await initDb();
  const sql = client();
  await sql`CREATE TABLE IF NOT EXISTS mcp_provider_credentials (
    owner_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider = 'openrouter'),
    credential TEXT NOT NULL,
    key_last4 TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}

function checkOwner(owner: string) {
  if (!ownerPattern.test(owner)) throw new Error("Invalid account identity");
}

export async function saveMcpProviderCredential(owner: string, apiKey: string) {
  checkOwner(owner);
  if (!keyPattern.test(apiKey) || apiKey.length > 500) throw new Error("Supply a valid OpenRouter API key");
  await ensureTable();
  const encrypted = encryptCredential(apiKey, `mcp-openrouter:${owner}`);
  const sql = client();
  await sql`INSERT INTO mcp_provider_credentials (owner_key,provider,credential,key_last4,verified_at,updated_at)
    VALUES (${owner},'openrouter',${encrypted},${apiKey.slice(-4)},NOW(),NOW())
    ON CONFLICT (owner_key) DO UPDATE SET
      provider='openrouter', credential=EXCLUDED.credential, key_last4=EXCLUDED.key_last4,
      verified_at=NOW(), updated_at=NOW()`;
  return getMcpProviderCredentialStatus(owner);
}

export async function getMcpProviderCredentialStatus(owner: string) {
  checkOwner(owner);
  await ensureTable();
  const sql = client();
  const rows = await sql`SELECT provider,key_last4,verified_at,updated_at
    FROM mcp_provider_credentials WHERE owner_key=${owner}`;
  if (!rows.length) return { enabled: false as const };
  const row = rows[0];
  return {
    enabled: true as const,
    provider: "openrouter" as const,
    keyLast4: String(row.key_last4),
    verifiedAt: new Date(String(row.verified_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function loadMcpProviderCredential(owner: string) {
  checkOwner(owner);
  await ensureTable();
  const sql = client();
  const rows = await sql`SELECT credential FROM mcp_provider_credentials WHERE owner_key=${owner}`;
  if (!rows.length) return null;
  return decryptCredential(String(rows[0].credential), `mcp-openrouter:${owner}`);
}

export async function deleteMcpProviderCredential(owner: string) {
  checkOwner(owner);
  await ensureTable();
  const sql = client();
  await sql`DELETE FROM mcp_provider_credentials WHERE owner_key=${owner}`;
}
