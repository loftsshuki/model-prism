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

  initialized = true;
}

// --- Queries ---

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

export async function updateRunCost(runId: string, totalCost: number) {
  await initDb();
  const sql = getClient();
  await sql`UPDATE runs SET total_cost = ${totalCost} WHERE id = ${runId}`;
}

export async function getRun(id: string) {
  await initDb();
  const sql = getClient();

  const runs = await sql`SELECT * FROM runs WHERE id = ${id}`;
  if (runs.length === 0) return null;

  const responses = await sql`
    SELECT * FROM responses WHERE run_id = ${id} ORDER BY created_at
  `;

  const syntheses = await sql`
    SELECT * FROM syntheses WHERE run_id = ${id} ORDER BY created_at DESC LIMIT 1
  `;

  const row = runs[0];
  return {
    ...row,
    models: JSON.parse(row.models as string),
    responses,
    synthesis: syntheses[0] ? JSON.parse(syntheses[0].result as string) : null,
    synthesisModel: syntheses[0]?.model_used ?? null,
  };
}

export async function listRuns() {
  await initDb();
  const sql = getClient();

  const runs = await sql`
    SELECT r.id, r.content, r.prompt, r.total_cost, r.context_metadata, r.created_at,
      COUNT(resp.id)::int as response_count,
      (SELECT COUNT(*)::int FROM syntheses s WHERE s.run_id = r.id) as has_synthesis
    FROM runs r
    LEFT JOIN responses resp ON resp.run_id = r.id
    GROUP BY r.id, r.content, r.prompt, r.total_cost, r.context_metadata, r.created_at
    ORDER BY r.created_at DESC
    LIMIT 50
  `;
  return runs;
}
