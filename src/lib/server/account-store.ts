import { neon } from "@neondatabase/serverless";
import { initDb } from "../db";
import { initFindingDb } from "./finding-store";
import { ReviewConflict } from "./background-store";
import { transaction, type DatabaseClient } from "./database";

let ready: Promise<void> | undefined;
export function initAccountDb() {
  ready ??= (async () => {
    await initFindingDb();
    await transaction(async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS account_recovery_audit (
        id BIGSERIAL PRIMARY KEY, account_owner TEXT NOT NULL, run_ids JSONB NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    });
  })().catch(error => { ready = undefined; throw error; });
  return ready;
}

export async function legacyOwnerIsClaimed(owner: string) {
  await initDb();
  const sql = neon(process.env.DATABASE_URL!);
  return (await sql`SELECT 1 FROM account_history_imports WHERE legacy_owner=${owner}`).length > 0;
}

async function importStatus(client: DatabaseClient, owner: string, legacy: string) {
  const claim = (await client.query("SELECT account_owner FROM account_history_imports WHERE legacy_owner=$1", [legacy])).rows[0];
  if (claim && claim.account_owner !== owner) throw new ReviewConflict("This key's history has already been imported into another account");
  const result = await client.query(`SELECT
    (SELECT COUNT(*)::int FROM runs WHERE owner_key=$1) AS reviews,
    (SELECT COUNT(*)::int FROM hook_jobs WHERE owner_key=$1) AS hooks,
    (SELECT COUNT(*)::int FROM run_telemetry WHERE owner_key=$1) AS telemetry,
    (SELECT COUNT(*)::int FROM review_jobs WHERE owner_key=$1 AND state IN ('queued','running','stopping')) AS active`, [legacy]);
  return { ...result.rows[0], imported: Boolean(claim) } as { reviews: number; hooks: number; telemetry: number; active: number; imported: boolean };
}
export async function previewHistoryImport(owner: string, legacy: string) {
  await initAccountDb();
  return transaction(client => importStatus(client, owner, legacy));
}

/** The capability proves access only to its existing records, never unowned data. */
export async function importKeyHistory(owner: string, legacy: string) {
  if (owner === legacy) throw new ReviewConflict("Sign in before importing key-based history");
  await initAccountDb();
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 3))", [legacy]);
    // Workers lock jobs before run snapshots. Keep that order and never move an
    // active credential whose encryption is bound to its original owner.
    await client.query("SELECT run_id FROM review_jobs WHERE owner_key=$1 ORDER BY run_id FOR UPDATE", [legacy]);
    const status = await importStatus(client, owner, legacy);
    if (status.active) throw new ReviewConflict("Wait for background reviews to finish or stop before importing history");
    await client.query("SELECT id FROM runs WHERE owner_key=$1 ORDER BY id FOR UPDATE", [legacy]);
    await client.query(`INSERT INTO review_findings (owner_key,project_key,fingerprint,state,dismissal_reason,note,updated_at)
      SELECT $2,project_key,fingerprint,state,dismissal_reason,note,updated_at FROM review_findings WHERE owner_key=$1
      ON CONFLICT (owner_key,project_key,fingerprint) DO UPDATE SET
        state=EXCLUDED.state,dismissal_reason=EXCLUDED.dismissal_reason,note=EXCLUDED.note,updated_at=EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at>review_findings.updated_at`, [legacy, owner]);
    await client.query("UPDATE review_finding_occurrences SET owner_key=$2 WHERE owner_key=$1", [legacy, owner]);
    await client.query("DELETE FROM review_findings WHERE owner_key=$1", [legacy]);
    await client.query("UPDATE review_jobs SET owner_key=$2,credential=NULL WHERE owner_key=$1", [legacy, owner]);
    await client.query(`INSERT INTO review_submissions (owner_key,submission_id,request_hash,run_id,execution,created_at)
      SELECT $2,submission_id,request_hash,run_id,execution,created_at FROM review_submissions WHERE owner_key=$1
      ON CONFLICT (owner_key,submission_id) DO NOTHING`, [legacy, owner]);
    await client.query("DELETE FROM review_submissions WHERE owner_key=$1", [legacy]);
    await client.query("UPDATE runs SET owner_key=$2 WHERE owner_key=$1", [legacy, owner]);
    await client.query("UPDATE run_telemetry SET owner_key=$2 WHERE owner_key=$1", [legacy, owner]);
    await client.query("UPDATE hook_jobs SET owner_key=$2 WHERE owner_key=$1", [legacy, owner]);
    await client.query("INSERT INTO account_history_imports (legacy_owner,account_owner) VALUES ($1,$2) ON CONFLICT (legacy_owner) DO NOTHING", [legacy, owner]);
    return status;
  });
}

/** Operator-only recovery: no public endpoint can assign unowned history. */
export async function recoverUnownedHistory(owner: string, runIds: string[], apply: boolean) {
  await initAccountDb();
  if (!runIds.length) throw new ReviewConflict("Select specific unowned review IDs");
  return transaction(async client => {
    const result = await client.query("SELECT id,owner_key FROM runs WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [runIds]);
    if (result.rows.length !== new Set(runIds).size || result.rows.some(row => row.owner_key && row.owner_key !== owner)) throw new ReviewConflict("A selected review is missing or belongs to another owner");
    const pending = result.rows.filter(row => !row.owner_key).map(row => String(row.id));
    if (apply && pending.length) {
      await client.query("UPDATE runs SET owner_key=$2 WHERE id=ANY($1::text[]) AND owner_key IS NULL", [pending, owner]);
      await client.query("UPDATE hook_jobs SET owner_key=$2 WHERE run_id=ANY($1::text[]) AND owner_key IS NULL", [pending, owner]);
      await client.query("INSERT INTO account_recovery_audit (account_owner,run_ids) VALUES ($1,$2::jsonb)", [owner, JSON.stringify(pending)]);
    }
    return { selected: runIds.length, recovered: apply ? pending.length : 0, pending: pending.length };
  });
}
