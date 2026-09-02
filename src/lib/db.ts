import { neon } from "@neondatabase/serverless";

function getClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return neon(url);
}

let initialized = false;

export async function initDb() {
  if (initialized) return;
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

  // Indexes for the per-run lookups (getRun, listRuns' join) and the history ordering.
  await sql`CREATE INDEX IF NOT EXISTS responses_run_id_idx ON responses (run_id)`;
  await sql`CREATE INDEX IF NOT EXISTS syntheses_run_id_idx ON syntheses (run_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS run_telemetry_created_at_idx ON run_telemetry (created_at DESC)`;
  // One row per (run, model): a retried model updates its row instead of duplicating it.
  // Existing databases may already hold duplicates from the old INSERT-only path;
  // keep the newest row per pair so the unique index can be created without failing.
  await sql`
    DELETE FROM responses a USING responses b
    WHERE a.run_id = b.run_id AND a.model = b.model AND a.id < b.id
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS responses_run_model_uidx ON responses (run_id, model)`;

  initialized = true;
}

// --- Queries ---

// A corrupt/legacy JSON column must not make a whole run unreadable.
function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export async function createRun(
  id: string,
  content: string,
  prompt: string,
  models: string[],
  contextMetadata?: string | null
) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO runs (id, content, prompt, models, context_metadata)
    VALUES (${id}, ${content}, ${prompt}, ${JSON.stringify(models)}, ${contextMetadata ?? null})
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
  await sql`
    INSERT INTO responses (run_id, model, model_name, base_architecture, response, error, time_ms, input_tokens, output_tokens, cost)
    VALUES (${runId}, ${model}, ${modelName}, ${family}, ${response}, ${error}, ${timeMs}, ${inputTokens}, ${outputTokens}, ${cost})
    ON CONFLICT (run_id, model) DO UPDATE SET
      model_name = EXCLUDED.model_name,
      base_architecture = EXCLUDED.base_architecture,
      response = EXCLUDED.response,
      error = EXCLUDED.error,
      time_ms = EXCLUDED.time_ms,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cost = EXCLUDED.cost,
      created_at = NOW()
  `;
  // Derive the run total from its responses so it is always the SUM, never the
  // last model's cost (the previous `SET total_cost = ${cost}` overwrote it).
  await sql`
    UPDATE runs SET total_cost = COALESCE((SELECT SUM(cost) FROM responses WHERE run_id = ${runId}), 0)
    WHERE id = ${runId}
  `;
}

export async function saveSynthesis(
  runId: string,
  result: string,
  modelUsed: string
) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO syntheses (run_id, result, model_used)
    VALUES (${runId}, ${result}, ${modelUsed})
  `;
}

export async function getRun(id: string) {
  await initDb();
  const sql = getClient();

  const runs = await sql`SELECT * FROM runs WHERE id = ${id}`;
  if (runs.length === 0) return null;

  const [responses, syntheses] = await Promise.all([
    sql`SELECT * FROM responses WHERE run_id = ${id} ORDER BY created_at`,
    sql`SELECT * FROM syntheses WHERE run_id = ${id} ORDER BY created_at DESC LIMIT 1`,
  ]);

  const row = runs[0];
  return {
    ...row,
    models: safeJson<string[]>(row.models, []),
    responses,
    synthesis: syntheses[0] ? safeJson<unknown>(syntheses[0].result, null) : null,
    synthesisModel: syntheses[0]?.model_used ?? null,
  };
}

export async function saveRunTelemetry(record: string) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO run_telemetry (record)
    VALUES (${record})
  `;
}

export async function listRunTelemetry(limit = 500): Promise<Array<{ record: string }>> {
  await initDb();
  const sql = getClient();
  const rows = await sql`
    SELECT record FROM run_telemetry
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({ record: String(row.record ?? "") }));
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

export async function listHookJobs(limit = 100) {
  await initDb();
  const sql = getClient();
  return sql`
    SELECT * FROM hook_jobs
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
}) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO hook_jobs (id, plan_file, status, run_id, cost, models, error, logs, updated_at)
    VALUES (${input.id}, ${input.planFile}, ${input.status}, ${input.runId ?? null}, ${input.cost ?? 0}, ${input.models ? JSON.stringify(input.models) : null}, ${input.error ?? null}, ${input.logs ?? null}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      plan_file = EXCLUDED.plan_file,
      status = EXCLUDED.status,
      run_id = EXCLUDED.run_id,
      cost = EXCLUDED.cost,
      models = EXCLUDED.models,
      error = EXCLUDED.error,
      logs = EXCLUDED.logs,
      updated_at = NOW()
  `;
}

export async function listRuns() {
  await initDb();
  const sql = getClient();

  const runs = await sql`
    SELECT r.id, LEFT(r.content, 400) AS content, LEFT(r.prompt, 400) AS prompt, r.total_cost, r.context_metadata, r.created_at,
      COUNT(resp.id)::int as response_count,
      (SELECT COUNT(*)::int FROM syntheses s WHERE s.run_id = r.id) as has_synthesis
    FROM runs r
    LEFT JOIN responses resp ON resp.run_id = r.id
    GROUP BY r.id, r.total_cost, r.context_metadata, r.created_at
    ORDER BY r.created_at DESC
    LIMIT 50
  `;
  return runs;
}
