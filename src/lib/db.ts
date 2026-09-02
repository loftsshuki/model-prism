import { neon } from "@neondatabase/serverless";
import type { ModelInfo } from "./types";
import type { ReviewJob, ReviewJobMode, ReviewJobPatch, ReviewJobStep } from "./job-types";
import { emptyStep } from "./job-types";

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

  // Human feedback on individual findings (thumbs up/down). Keyed by the stable
  // finding id (hash of the normalized claim) so votes survive re-reviews and can
  // be joined back to the models that raised the finding.
  await sql`
    CREATE TABLE IF NOT EXISTS finding_feedback (
      id SERIAL PRIMARY KEY,
      run_id TEXT,
      finding_id TEXT NOT NULL,
      claim TEXT,
      section TEXT,
      models TEXT,
      vote INTEGER NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS finding_feedback_finding_idx ON finding_feedback (finding_id)`;
  await sql`CREATE INDEX IF NOT EXISTS finding_feedback_run_idx ON finding_feedback (run_id)`;

  // Durable server-side review runs: one row per job, advanced one step per
  // worker invocation (see src/lib/jobs.ts). `step` is JSON progress; `locked_until`
  // is the claim lease so concurrent workers never advance the same job.
  await sql`
    CREATE TABLE IF NOT EXISTS review_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      content TEXT NOT NULL,
      prompt TEXT NOT NULL,
      models TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'legacy',
      run_id TEXT REFERENCES runs(id),
      context TEXT,
      step TEXT NOT NULL,
      cost REAL DEFAULT 0,
      error TEXT,
      attempts INTEGER DEFAULT 0,
      locked_until TIMESTAMP,
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

  // The worker claims the oldest active job: filter on status, order on created_at.
  await sql`CREATE INDEX IF NOT EXISTS review_jobs_status_idx ON review_jobs (status)`;
  await sql`CREATE INDEX IF NOT EXISTS review_jobs_created_at_idx ON review_jobs (created_at)`;

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

export interface FindingFeedbackRow {
  run_id: string | null;
  finding_id: string;
  claim: string | null;
  section: string | null;
  models: string[];
  vote: number;
  note: string | null;
  created_at: string;
}

export async function saveFindingFeedback(input: {
  runId: string | null;
  findingId: string;
  claim?: string | null;
  section?: string | null;
  models?: string[] | null;
  vote: 1 | -1;
  note?: string | null;
}) {
  await initDb();
  const sql = getClient();
  await sql`
    INSERT INTO finding_feedback (run_id, finding_id, claim, section, models, vote, note)
    VALUES (${input.runId}, ${input.findingId}, ${input.claim ?? null}, ${input.section ?? null}, ${input.models ? JSON.stringify(input.models) : null}, ${input.vote}, ${input.note ?? null})
  `;
}

export async function listFindingFeedback(opts: { runId?: string; limit?: number } = {}): Promise<FindingFeedbackRow[]> {
  await initDb();
  const sql = getClient();
  const limit = opts.limit ?? 2000;
  const rows = opts.runId
    ? await sql`SELECT * FROM finding_feedback WHERE run_id = ${opts.runId} ORDER BY created_at DESC LIMIT ${limit}`
    : await sql`SELECT * FROM finding_feedback ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    run_id: (r.run_id as string | null) ?? null,
    finding_id: String(r.finding_id),
    claim: (r.claim as string | null) ?? null,
    section: (r.section as string | null) ?? null,
    models: safeJson<string[]>(r.models, []),
    vote: Number(r.vote),
    note: (r.note as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

// --- Review jobs (durable server-side runs) ---

/** How long one claim holds a job. A step that dies mid-way (timeout, redeploy) is re-claimable after this. */
export const JOB_LOCK_MINUTES = 5;

const REVIEW_JOB_LIST_LIMIT = 50;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// Row → typed job. JSON columns are parsed tolerantly (a corrupt `step` becomes an
// empty council so the worker fails the job cleanly instead of crashing).
function rowToReviewJob(row: Record<string, unknown>): ReviewJob {
  return {
    id: String(row.id),
    status: String(row.status) as ReviewJob["status"],
    content: String(row.content ?? ""),
    prompt: String(row.prompt ?? ""),
    models: safeJson<ModelInfo[]>(row.models, []),
    mode: (row.mode === "fusion" ? "fusion" : "legacy") as ReviewJobMode,
    run_id: String(row.run_id ?? ""),
    context: typeof row.context === "string" ? row.context : null,
    step: safeJson<ReviewJobStep>(row.step, emptyStep([])),
    cost: Number(row.cost ?? 0),
    error: typeof row.error === "string" ? row.error : null,
    attempts: Number(row.attempts ?? 0),
    locked_until: toIso(row.locked_until),
    created_at: toIso(row.created_at) ?? "",
    updated_at: toIso(row.updated_at) ?? "",
  };
}

export async function enqueueReviewJob(input: {
  id: string;
  runId: string;
  content: string;
  prompt: string;
  models: ModelInfo[];
  mode: ReviewJobMode;
  context?: string | null;
}): Promise<ReviewJob> {
  await initDb();
  const sql = getClient();
  // The run row is created first so responses/synthesis have a parent to attach to
  // and the job shows up in history like a browser-driven run.
  await createRun(input.runId, input.content, input.prompt, input.models.map((m) => m.id), null);
  const step = emptyStep(input.models.map((m) => m.id));
  const rows = await sql`
    INSERT INTO review_jobs (id, status, content, prompt, models, mode, run_id, context, step, cost, attempts)
    VALUES (${input.id}, 'queued', ${input.content}, ${input.prompt}, ${JSON.stringify(input.models)}, ${input.mode}, ${input.runId}, ${input.context ?? null}, ${JSON.stringify(step)}, 0, 0)
    RETURNING *
  `;
  return rowToReviewJob(rows[0]);
}

/**
 * Atomically claim the oldest job that is active and not leased. One statement so the
 * Neon HTTP driver (no session/transaction) still gets an atomic claim; SKIP LOCKED
 * keeps two workers from racing on the same row. A queued job becomes running here.
 */
export async function claimNextReviewJob(): Promise<ReviewJob | null> {
  await initDb();
  const sql = getClient();
  const rows = await sql`
    UPDATE review_jobs
    SET locked_until = NOW() + (${JOB_LOCK_MINUTES}::int) * INTERVAL '1 minute',
        status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM review_jobs
      WHERE status IN ('queued', 'running', 'synthesizing')
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return rows[0] ? rowToReviewJob(rows[0]) : null;
}

export async function updateReviewJob(id: string, patch: ReviewJobPatch): Promise<ReviewJob> {
  await initDb();
  const sql = getClient();
  const extend = patch.lock === "extend";
  // A cancel that lands while a step is running must win: the step's own writes
  // (progress heartbeats, phase transitions) never resurrect a cancelled job.
  const rows = await sql`
    UPDATE review_jobs
    SET status = CASE WHEN status = 'cancelled' THEN status ELSE ${patch.status} END,
        step = ${JSON.stringify(patch.step)},
        cost = ${patch.cost},
        error = ${patch.error},
        attempts = ${patch.attempts},
        locked_until = CASE WHEN ${extend}::boolean THEN NOW() + (${JOB_LOCK_MINUTES}::int) * INTERVAL '1 minute' ELSE NULL END,
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!rows[0]) throw new Error(`Review job ${id} not found`);
  return rowToReviewJob(rows[0]);
}

export async function getReviewJob(id: string): Promise<ReviewJob | null> {
  await initDb();
  const sql = getClient();
  const rows = await sql`SELECT * FROM review_jobs WHERE id = ${id}`;
  return rows[0] ? rowToReviewJob(rows[0]) : null;
}

export async function listReviewJobs(limit = REVIEW_JOB_LIST_LIMIT): Promise<ReviewJob[]> {
  await initDb();
  const sql = getClient();
  const rows = await sql`
    SELECT * FROM review_jobs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToReviewJob);
}

/** Cancel an active job. Returns null when the job does not exist or already finished. */
export async function cancelReviewJob(id: string): Promise<ReviewJob | null> {
  await initDb();
  const sql = getClient();
  const rows = await sql`
    UPDATE review_jobs
    SET status = 'cancelled', locked_until = NULL, updated_at = NOW()
    WHERE id = ${id} AND status IN ('queued', 'running', 'synthesizing')
    RETURNING *
  `;
  return rows[0] ? rowToReviewJob(rows[0]) : null;
}

export interface RunResponseRow {
  model: string;
  model_name: string | null;
  base_architecture: string | null;
  response: string | null;
  error: string | null;
  cost: number | null;
  time_ms: number | null;
  created_at: string | null;
}

/** The council responses saved for a run (the worker feeds these to the judge/synthesizer). */
export async function listRunResponses(runId: string): Promise<RunResponseRow[]> {
  await initDb();
  const sql = getClient();
  const rows = await sql`
    SELECT model, model_name, base_architecture, response, error, cost, time_ms, created_at
    FROM responses WHERE run_id = ${runId} ORDER BY created_at
  `;
  return rows.map((row) => ({
    model: String(row.model),
    model_name: typeof row.model_name === "string" ? row.model_name : null,
    base_architecture: typeof row.base_architecture === "string" ? row.base_architecture : null,
    response: typeof row.response === "string" ? row.response : null,
    error: typeof row.error === "string" ? row.error : null,
    cost: row.cost == null ? null : Number(row.cost),
    time_ms: row.time_ms == null ? null : Number(row.time_ms),
    created_at: toIso(row.created_at),
  }));
}
