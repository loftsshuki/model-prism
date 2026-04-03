import { createClient } from "@libsql/client";

function getClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    // Local dev fallback: file-based SQLite
    return createClient({ url: "file:local.db" });
  }

  return createClient({ url, authToken });
}

let client: ReturnType<typeof createClient> | null = null;

export function db() {
  if (!client) {
    client = getClient();
  }
  return client;
}

export async function initDb() {
  const d = db();

  await d.executeMultiple(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      prompt TEXT NOT NULL,
      models TEXT NOT NULL,
      total_cost REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS syntheses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT REFERENCES runs(id),
      result TEXT NOT NULL,
      model_used TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// Auto-init on first import
const _init = initDb().catch(console.error);

// --- Queries ---

export async function createRun(
  id: string,
  content: string,
  prompt: string,
  models: string[]
) {
  await _init;
  await db().execute({
    sql: "INSERT INTO runs (id, content, prompt, models) VALUES (?, ?, ?, ?)",
    args: [id, content, prompt, JSON.stringify(models)],
  });
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
  await _init;
  await db().execute({
    sql: `INSERT INTO responses (run_id, model, model_name, base_architecture, response, error, time_ms, input_tokens, output_tokens, cost)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [runId, model, modelName, family, response, error, timeMs, inputTokens, outputTokens, cost],
  });
}

export async function saveSynthesis(
  runId: string,
  result: string,
  modelUsed: string
) {
  await _init;
  await db().execute({
    sql: "INSERT INTO syntheses (run_id, result, model_used) VALUES (?, ?, ?)",
    args: [runId, result, modelUsed],
  });
}

export async function updateRunCost(runId: string, totalCost: number) {
  await _init;
  await db().execute({
    sql: "UPDATE runs SET total_cost = ? WHERE id = ?",
    args: [totalCost, runId],
  });
}

export async function getRun(id: string) {
  await _init;
  const run = await db().execute({
    sql: "SELECT * FROM runs WHERE id = ?",
    args: [id],
  });
  if (run.rows.length === 0) return null;

  const responses = await db().execute({
    sql: "SELECT * FROM responses WHERE run_id = ? ORDER BY created_at",
    args: [id],
  });

  const syntheses = await db().execute({
    sql: "SELECT * FROM syntheses WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
    args: [id],
  });

  return {
    ...run.rows[0],
    models: JSON.parse(run.rows[0].models as string),
    responses: responses.rows,
    synthesis: syntheses.rows[0] ? JSON.parse(syntheses.rows[0].result as string) : null,
    synthesisModel: syntheses.rows[0]?.model_used ?? null,
  };
}

export async function listRuns() {
  await _init;
  const runs = await db().execute({
    sql: `SELECT r.id, r.content, r.prompt, r.total_cost, r.created_at,
            COUNT(resp.id) as response_count,
            (SELECT COUNT(*) FROM syntheses s WHERE s.run_id = r.id) as has_synthesis
          FROM runs r
          LEFT JOIN responses resp ON resp.run_id = r.id
          GROUP BY r.id
          ORDER BY r.created_at DESC
          LIMIT 50`,
    args: [],
  });
  return runs.rows;
}
