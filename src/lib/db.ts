import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import { checkpointCost, sameReviewInput, type RunCheckpoint } from "./run-checkpoint";
import { buildRunTelemetry } from "./telemetry";

function getClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return neon(url);
}

let initialized = false;
let initializing: Promise<void> | null = null;

export async function initDb() {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = initializeDb();
  try { await initializing; } finally { initializing = null; }
}

async function initializeDb() {
  const sql = getClient();

  await sql`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      prompt TEXT NOT NULL,
      models TEXT NOT NULL,
      total_cost REAL DEFAULT 0,
      context_metadata TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Migration: add context_metadata column if it doesn't exist
  await sql`
    DO $$ BEGIN
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS context_metadata TEXT;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `;
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS snapshot JSONB`;
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS snapshot_revision INTEGER DEFAULT 0`;
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS owner_key TEXT`;

  await sql`
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      model TEXT NOT NULL,
      model_name TEXT,
      base_architecture TEXT,
      response TEXT,
      error TEXT,
      time_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost REAL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS syntheses (
      id SERIAL PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      result TEXT NOT NULL,
      model_used TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS run_telemetry (
      id SERIAL PRIMARY KEY,
      record TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS save_key TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS response_save_key ON responses (run_id, save_key)`;
  await sql`ALTER TABLE syntheses ADD COLUMN IF NOT EXISTS save_key TEXT`;
  await sql`ALTER TABLE run_telemetry ADD COLUMN IF NOT EXISTS owner_key TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS synthesis_save_key ON syntheses (run_id, save_key)`;

  await sql`
    CREATE TABLE IF NOT EXISTS plan_statuses (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      approved_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS hook_jobs (
      id TEXT PRIMARY KEY,
      plan_file TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      cost REAL DEFAULT 0,
      models TEXT,
      error TEXT,
      logs TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE hook_jobs ADD COLUMN IF NOT EXISTS owner_key TEXT`;

  initialized = true;
}

// --- Queries ---

export async function createRun(
  id: string,
  content: string,
  prompt: string,
  models: string[],
  contextMetadata?: string | null,
  owner: string | null = null
) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO runs (id, content, prompt, models, context_metadata, owner_key)
    VALUES (${id}, ${content}, ${prompt}, ${JSON.stringify(models)}, ${contextMetadata ?? null}, ${owner})
  `;
}

export async function saveResponse(
  runId: string,
  model: string,
  modelName: string,
  family: string,
  response: string | null,
  error: string | null,
  timeMs: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
  cost: number | null
) {
  await initDb();
  const sql = getClient();
  const saveKey = createHash("sha256").update(JSON.stringify([model, response, error, timeMs, inputTokens, outputTokens, cost])).digest("hex");
  await sql`
    INSERT INTO responses (run_id, model, model_name, base_architecture, response, error, time_ms, input_tokens, output_tokens, cost, save_key)
    VALUES (${runId}, ${model}, ${modelName}, ${family}, ${response}, ${error}, ${timeMs}, ${inputTokens}, ${outputTokens}, ${cost}, ${saveKey})
    ON CONFLICT (run_id, save_key) DO NOTHING
  `;
}

export async function saveSynthesis(
  runId: string,
  result: string,
  modelUsed: string
) {
  await initDb();
  const sql = getClient();
  const saveKey = createHash("sha256").update(modelUsed + result).digest("hex");
  await sql`
    INSERT INTO syntheses (run_id, result, model_used, save_key)
    VALUES (${runId}, ${result}, ${modelUsed}, ${saveKey})
    ON CONFLICT (run_id, save_key) DO NOTHING
  `;
}

export async function updateRunCost(runId: string, totalCost: number) {
  await initDb();
  const sql = getClient();
  // Legacy callers send a response cost, not the accumulated run total.
  // Recomputing is idempotent and prevents a late response replacing the total.
  void totalCost;
  await sql`UPDATE runs SET total_cost = COALESCE((SELECT SUM(cost) FROM responses WHERE run_id = ${runId}), 0)
    + COALESCE((SELECT SUM(COALESCE((entry->>'cost')::double precision, 0)) FROM syntheses,
      LATERAL jsonb_array_elements(COALESCE(result::jsonb->'usage', '[]'::jsonb)) entry WHERE run_id = ${runId}), 0)
    WHERE id = ${runId} AND snapshot IS NULL`;
}

export async function saveRunCheckpoint(snapshot: RunCheckpoint, owner: string) {
  if (snapshot.background) throw new Error("RUN_CONFLICT");
  await initDb();
  const sql = getClient();
  const existing = await sql`SELECT snapshot, snapshot_revision, owner_key FROM runs WHERE id = ${snapshot.id}`;
  if (existing.length && existing[0].owner_key !== owner) throw new Error("RUN_CONFLICT");
  const previous = existing[0]?.snapshot as RunCheckpoint | undefined;
  if (previous?.background) throw new Error("RUN_CONFLICT");
  if (previous && !sameReviewInput(previous, snapshot)) throw new Error("RUN_CONFLICT");
  if (previous && previous.revision > snapshot.revision) throw new Error("RUN_CONFLICT");
  await sql`INSERT INTO runs (id, content, prompt, models, context_metadata, total_cost, snapshot, snapshot_revision, created_at, owner_key)
    VALUES (${snapshot.id}, ${snapshot.content}, ${snapshot.prompt}, ${JSON.stringify(snapshot.models.map((model) => model.id))}, ${snapshot.contextMetadata ?? null}, ${checkpointCost(snapshot)}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.revision}, ${snapshot.createdAt}, ${owner})
    ON CONFLICT (id) DO UPDATE SET models = EXCLUDED.models, total_cost = EXCLUDED.total_cost,
      snapshot = EXCLUDED.snapshot, snapshot_revision = EXCLUDED.snapshot_revision
    WHERE runs.snapshot_revision < EXCLUDED.snapshot_revision
      AND runs.owner_key = EXCLUDED.owner_key
      AND (runs.snapshot IS NULL OR runs.snapshot->'background' IS NULL)
      AND runs.content = EXCLUDED.content AND runs.prompt = EXCLUDED.prompt
      AND (runs.snapshot IS NULL OR (runs.snapshot->>'context' = EXCLUDED.snapshot->>'context'
        AND runs.snapshot->>'reasoningEffort' = EXCLUDED.snapshot->>'reasoningEffort'))`;
}

export async function getRun(id: string, owner: string | null = null) {
  if (!owner) return null;
  await initDb();
  const sql = getClient();

  const runs = await sql`SELECT * FROM runs WHERE id = ${id} AND owner_key = ${owner}`;
  if (runs.length === 0) return null;

  const responses = await sql`
    SELECT * FROM responses WHERE run_id = ${id} ORDER BY created_at
  `;

  const syntheses = await sql`
    SELECT * FROM syntheses WHERE run_id = ${id} ORDER BY created_at DESC LIMIT 1
  `;

  const row = runs[0];
  const snapshot = row.snapshot as RunCheckpoint | null;
  return {
    ...row,
    snapshot,
    models: JSON.parse(row.models as string),
    responses: snapshot ? snapshot.responses.map((response, index) => ({ ...response, id: index, model_name: response.modelName, base_architecture: response.family, time_ms: response.timeMs, input_tokens: response.inputTokens, output_tokens: response.outputTokens })) : responses,
    synthesis: snapshot?.synthesis ?? (syntheses[0] ? JSON.parse(syntheses[0].result as string) : null),
    synthesisModel: snapshot?.synthesisModel ?? syntheses[0]?.model_used ?? null,
  };
}

export async function saveRunTelemetry(record: string, owner: string | null = null) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO run_telemetry (record, owner_key)
    VALUES (${record}, ${owner})
  `;
}

export async function listRunTelemetry(limit = 500, owner: string | null = null): Promise<Array<{ record: string }>> {
  if (!owner) return [];
  await initDb();
  const sql = getClient();
  const rows = await sql`
    SELECT record FROM run_telemetry
    WHERE owner_key = ${owner}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  const snapshots = await sql`SELECT snapshot FROM runs WHERE owner_key = ${owner} AND snapshot->'synthesis' IS NOT NULL ORDER BY created_at DESC LIMIT ${limit}`;
  return [...rows.map((row) => ({ record: String(row.record ?? "") })), ...snapshots.map((row) => {
    const run = row.snapshot as RunCheckpoint;
    return { record: JSON.stringify(buildRunTelemetry({ ts: run.createdAt, plan: "web-review", contentHash: run.id, contextRepo: "private-context", roster: "custom", synthesisModel: run.synthesisModel, durationSec: Math.round((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000), synthesis: run.synthesis!, responses: run.responses, usedModels: run.models })) };
  })];
}

export async function getPlanStatus(runId: string) {
  await initDb();
  const sql = getClient();
  const rows = await sql`SELECT * FROM plan_statuses WHERE run_id = ${runId}`;
  return rows[0] ?? null;
}

export async function savePlanStatus(runId: string, status: string, approvedAt?: string | null) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO plan_statuses (run_id, status, approved_at, updated_at)
    VALUES (${runId}, ${status}, ${approvedAt ?? null}, NOW())
    ON CONFLICT (run_id) DO UPDATE SET
      status = EXCLUDED.status,
      approved_at = EXCLUDED.approved_at,
      updated_at = NOW()
  `;
}

export async function listHookJobs(limit = 100, owner: string | null = null) {
  if (!owner) return [];
  await initDb();
  const sql = getClient();
  return sql`
    SELECT * FROM hook_jobs
    WHERE owner_key = ${owner}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export async function upsertHookJob(input: {
  id: string;
  planFile: string;
  status: string;
  runId?: string | null;
  cost?: number | null;
  models?: string[] | null;
  error?: string | null;
  logs?: string | null;
}, owner: string | null = null) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO hook_jobs (id, plan_file, status, run_id, cost, models, error, logs, updated_at, owner_key)
    VALUES (${input.id}, ${input.planFile}, ${input.status}, ${input.runId ?? null}, ${input.cost ?? 0}, ${input.models ? JSON.stringify(input.models) : null}, ${input.error ?? null}, ${input.logs ?? null}, NOW(), ${owner})
    ON CONFLICT (id) DO UPDATE SET
      plan_file = EXCLUDED.plan_file,
      status = EXCLUDED.status,
      run_id = EXCLUDED.run_id,
      cost = EXCLUDED.cost,
      models = EXCLUDED.models,
      error = EXCLUDED.error,
      logs = EXCLUDED.logs,
      updated_at = NOW()
    WHERE hook_jobs.owner_key = EXCLUDED.owner_key
  `;
}

export async function listRuns(owner: string | null = null) {
  if (!owner) return [];
  await initDb();
  const sql = getClient();

  const runs = await sql`
    SELECT r.id, r.content, r.prompt, r.total_cost, r.context_metadata, r.created_at, r.snapshot->'background' AS background,
      CASE WHEN r.snapshot IS NOT NULL THEN jsonb_array_length(r.snapshot->'responses') ELSE COUNT(resp.id)::int END as response_count,
      CASE WHEN r.snapshot IS NOT NULL THEN CASE WHEN r.snapshot->'synthesis' IS NOT NULL THEN 1 ELSE 0 END ELSE (SELECT COUNT(*)::int FROM syntheses s WHERE s.run_id = r.id) END as has_synthesis
    FROM runs r
    LEFT JOIN responses resp ON resp.run_id = r.id
    WHERE r.owner_key = ${owner}
    GROUP BY r.id, r.content, r.prompt, r.total_cost, r.context_metadata, r.created_at
    ORDER BY r.created_at DESC
    LIMIT 50
  `;
  return runs;
}
