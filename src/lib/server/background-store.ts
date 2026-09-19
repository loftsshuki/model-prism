import { createHash, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { initDb } from "../db";
import { RunBudget, BudgetExceededError } from "../run-budget";
import { checkpointCost, sameReviewInput, type RunCheckpoint } from "../run-checkpoint";
import { initialCouncil, type BackgroundReviewInput } from "../review-policy";
import type { ModelInfo, ModelUsage } from "../types";
import { transaction, type DatabaseClient } from "./database";
import { encryptCredential } from "./credentials";

type JobState = NonNullable<RunCheckpoint["background"]>["state"];
export interface WorkerJob {
  runId: string; owner: string; execution: number; workflowId: string | null; cancelRequested: boolean;
  credential: string | null; credentialExpires: string; config: BackgroundReviewInput; snapshot: RunCheckpoint;
}
export class ReviewConflict extends Error {}
let ready: Promise<void> | undefined;
export function initBackgroundDb() {
  ready ??= initialize().catch(error => { ready = undefined; throw error; });
  return ready;
}
async function initialize() {
  await initDb();
  await transaction(async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS review_jobs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, owner_key TEXT NOT NULL,
      execution INTEGER NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL,
      workflow_id TEXT, cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
      credential TEXT, credential_expires TIMESTAMPTZ NOT NULL, config JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS active_review_request ON review_jobs (owner_key, request_hash)
      WHERE state IN ('queued', 'running', 'stopping')`);
    await client.query(`CREATE TABLE IF NOT EXISTS review_operations (
      run_id TEXT REFERENCES review_jobs(run_id) ON DELETE CASCADE, execution INTEGER NOT NULL,
      slot TEXT NOT NULL, state TEXT NOT NULL, lease_until TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (run_id, execution, slot))`);
    await client.query(`CREATE TABLE IF NOT EXISTS review_submissions (
      owner_key TEXT NOT NULL, submission_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, execution INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(owner_key, submission_id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS model_freshness_checks (
      id INTEGER PRIMARY KEY CHECK (id = 1), checked_at TIMESTAMPTZ NOT NULL, report JSONB NOT NULL)`);
  });
}

function decode(row: Record<string, unknown>): WorkerJob {
  return { runId: String(row.run_id), owner: String(row.owner_key), execution: Number(row.execution),
    workflowId: row.workflow_id ? String(row.workflow_id) : null, cancelRequested: Boolean(row.cancel_requested),
    credential: row.credential ? String(row.credential) : null, credentialExpires: new Date(String(row.credential_expires)).toISOString(),
    config: row.config as BackgroundReviewInput, snapshot: row.snapshot as RunCheckpoint };
}
async function lockJob(client: DatabaseClient, runId: string) {
  const result = await client.query("SELECT * FROM review_jobs WHERE run_id=$1 FOR UPDATE", [runId]);
  if (!result.rows[0]) throw new ReviewConflict("Review not found");
  // A joined SELECT that waits for j's lock can retain an old r.snapshot under
  // READ COMMITTED. Read the ledger in a new statement after acquiring the lock.
  const run = await client.query("SELECT snapshot FROM runs WHERE id=$1 FOR UPDATE", [runId]);
  return decode({ ...result.rows[0], snapshot: run.rows[0].snapshot });
}
async function writeJob(client: DatabaseClient, job: WorkerJob) {
  job.snapshot.revision++;
  job.snapshot.updatedAt = new Date().toISOString();
  const state = job.snapshot.background!.state;
  if (["complete", "stopped", "error"].includes(state)) job.credential = null;
  await client.query(`UPDATE review_jobs SET state=$2, workflow_id=$3, cancel_requested=$4, credential=$5, config=$6::jsonb, updated_at=NOW() WHERE run_id=$1`,
    [job.runId, state, job.workflowId, job.cancelRequested, job.credential, JSON.stringify(job.config)]);
  await client.query(`UPDATE runs SET snapshot=$2::jsonb, snapshot_revision=$3, total_cost=$4 WHERE id=$1`,
    [job.runId, JSON.stringify(job.snapshot), job.snapshot.revision, checkpointCost(job.snapshot)]);
}
export async function changeJob<T>(runId: string, execution: number, operation: (job: WorkerJob, client: DatabaseClient) => Promise<T>): Promise<T> {
  await initBackgroundDb();
  return transaction(async client => {
    const job = await lockJob(client, runId);
    if (job.execution !== execution) throw new ReviewConflict("A newer execution owns this review");
    const result = await operation(job, client);
    await writeJob(client, job);
    return result;
  });
}
export async function loadWorkerJob(runId: string): Promise<WorkerJob> {
  await initBackgroundDb();
  return transaction(async client => {
    const result = await client.query(`SELECT j.*, r.snapshot FROM review_jobs j JOIN runs r ON r.id=j.run_id WHERE j.run_id=$1`, [runId]);
    if (!result.rows[0]) throw new ReviewConflict("Review not found");
    return decode(result.rows[0]);
  });
}

export async function jobIsActive(runId: string, execution: number) {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = await sql`SELECT 1 FROM review_jobs WHERE run_id=${runId} AND execution=${execution}
    AND NOT cancel_requested AND state IN ('queued','running') AND credential_expires>NOW()`;
  return rows.length > 0;
}

export async function startBackgroundReview(input: BackgroundReviewInput, owner: string, apiKey: string, catalog: ModelInfo[], submissionId: string = randomUUID()) {
  await initBackgroundDb();
  const { id: ignoredId, ...identity } = input;
  const requestHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const models = input.modelIds.map(id => catalog.find(model => model.id === id));
  if (models.some(model => !model) || !catalog.some(model => model.id === input.synthesisModel && model.toolCallApi !== "responses" && model.supportedParameters?.includes("tools"))) throw new ReviewConflict("Refresh the catalog and choose available reviewers and a tool-capable synthesizer");
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [owner + submissionId]);
    const submitted = await client.query("SELECT run_id,execution,request_hash FROM review_submissions WHERE owner_key=$1 AND submission_id=$2", [owner, submissionId]);
    if (submitted.rows[0]) {
      if (submitted.rows[0].request_hash !== requestHash) throw new ReviewConflict("A submission ID cannot be reused for different input");
      return { id: String(submitted.rows[0].run_id), execution: Number(submitted.rows[0].execution), started: false };
    }
    const remember = async (result: { id: string; execution: number; started: boolean }) => {
      await client.query("INSERT INTO review_submissions (owner_key,submission_id,request_hash,run_id,execution) VALUES ($1,$2,$3,$4,$5)", [owner, submissionId, requestHash, result.id, result.execution]);
      return result;
    };
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner + requestHash]);
    const active = await client.query(`SELECT run_id, execution FROM review_jobs WHERE owner_key=$1 AND request_hash=$2 AND state IN ('queued','running','stopping')`, [owner, requestHash]);
    if (active.rows[0]) return remember({ id: String(active.rows[0].run_id), execution: Number(active.rows[0].execution), started: false });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [input.id]);
    const priorJob = await client.query("SELECT execution, state FROM review_jobs WHERE run_id=$1 FOR UPDATE", [input.id]);
    const existing = await client.query("SELECT owner_key, snapshot FROM runs WHERE id=$1 FOR UPDATE", [ignoredId]);
    if (existing.rows[0] && existing.rows[0].owner_key !== owner) throw new ReviewConflict("Review not found");
    const previous = existing.rows[0]?.snapshot as RunCheckpoint | undefined;
    if (existing.rows[0] && !previous) throw new ReviewConflict("Start a new review to continue a legacy run");
    if (previous && !sameReviewInput(previous, input)) throw new ReviewConflict("Edited input must start a new review");
    if (previous?.background && (JSON.stringify(previous.sources ?? []) !== JSON.stringify(input.sources) || previous.projectKey !== input.projectKey || previous.baselineRunId !== input.baselineRunId)) throw new ReviewConflict("Changed source files or project must start a new review");
    if (priorJob.rows[0] && ["queued", "running", "stopping"].includes(priorJob.rows[0].state)) return remember({ id: input.id, execution: Number(priorJob.rows[0].execution), started: false });
    if (previous && checkpointCost(previous) >= input.maxCost) throw new BudgetExceededError();
    if (input.secondPass && !previous?.synthesis) throw new ReviewConflict("Complete the first synthesis before requesting a second pass");
    if (input.baselineRunId) {
    const baseline = await client.query("SELECT id FROM runs WHERE id=$1 AND owner_key=$2 AND COALESCE(snapshot->>'projectKey', 'default')=$3", [input.baselineRunId, owner, input.projectKey]);
      if (!baseline.rows.length) throw new ReviewConflict("The comparison review is not in this project's private history");
    }
    const execution = Number(priorJob.rows[0]?.execution ?? 0) + 1;
    const now = new Date().toISOString();
    const completed = new Set(previous?.responses.filter(response => response.status === "complete").map(response => response.requestedModel ?? response.model));
    const invalidated = input.modelIds.some(id => !completed.has(id)) || previous?.synthesisModel !== input.synthesisModel;
    const initial = initialCouncil(models as ModelInfo[], input.adaptive, input.risk);
    const initialIds = (models as ModelInfo[]).filter(model => initial.some(item => item.id === model.id)
      || previous?.responses.some(response => (response.requestedModel ?? response.model) === model.id)).map(model => model.id);
    const snapshot: RunCheckpoint = {
      version: 1, id: input.id, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      content: input.content, prompt: input.prompt, context: input.context, reasoningEffort: input.reasoningEffort,
      models: models as ModelInfo[], responses: previous?.responses ?? [], usage: previous?.usage ?? [],
      status: "running", synthesisModel: input.synthesisModel, maxCost: input.maxCost, maxTokens: input.maxTokens, synthesisMaxTokens: input.synthesisMaxTokens,
      synthesis: invalidated && !input.secondPass ? undefined : previous?.synthesis,
      secondPass: invalidated ? undefined : previous?.secondPass, contextMetadata: input.contextMetadata, sources: input.sources,
      projectKey: input.projectKey, baselineRunId: input.baselineRunId,
      background: { execution, state: "queued", phase: "Queued" },
      adaptive: { enabled: input.adaptive, initialIds, escalatedIds: [], reasons: input.risk === "high" ? ["High-risk review uses the full selected council"] : [] },
    };
    const saved = await client.query(`INSERT INTO runs (id,content,prompt,models,owner_key,snapshot,snapshot_revision,total_cost,created_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET snapshot=EXCLUDED.snapshot, snapshot_revision=EXCLUDED.snapshot_revision, models=EXCLUDED.models
      WHERE runs.owner_key=EXCLUDED.owner_key AND runs.content=EXCLUDED.content AND runs.prompt=EXCLUDED.prompt`,
    [input.id, input.content, input.prompt, JSON.stringify(input.modelIds), owner, JSON.stringify(snapshot), snapshot.revision, checkpointCost(snapshot), snapshot.createdAt]);
    if (!saved.rowCount) throw new ReviewConflict("Review not found or input changed");
    const credential = encryptCredential(apiKey, `${owner}:${input.id}:${execution}`);
    await client.query(`INSERT INTO review_jobs (run_id,owner_key,execution,request_hash,state,credential,credential_expires,config)
      VALUES ($1,$2,$3,$4,'queued',$5,NOW()+INTERVAL '24 hours',$6::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET execution=EXCLUDED.execution, request_hash=EXCLUDED.request_hash, state='queued',
        workflow_id=NULL, cancel_requested=FALSE, credential=EXCLUDED.credential, credential_expires=EXCLUDED.credential_expires, config=EXCLUDED.config, updated_at=NOW()`,
    [input.id, owner, execution, requestHash, credential, JSON.stringify(input)]);
    return remember({ id: input.id, execution, started: true });
  });
}

export async function claimWorkflow(runId: string, execution: number, workflowId: string) {
  return changeJob(runId, execution, async job => {
    if (job.workflowId && job.workflowId !== workflowId) return false;
    if (job.cancelRequested || !["queued", "running"].includes(job.snapshot.background!.state)) return false;
    job.workflowId = workflowId; job.snapshot.background!.state = "running";
    return true;
  });
}
export async function beginOperation(runId: string, execution: number, slot: string): Promise<"start" | "done" | "wait" | "stop"> {
  return changeJob(runId, execution, async (job, client) => {
    if (job.cancelRequested || !["running", "queued"].includes(job.snapshot.background!.state)) return "stop";
    const found = await client.query("SELECT state, lease_until FROM review_operations WHERE run_id=$1 AND execution=$2 AND slot=$3", [runId, execution, slot]);
    if (found.rows[0]?.state === "done") return "done";
    if (found.rows[0]) {
      if (new Date(found.rows[0].lease_until).getTime() > Date.now()) return "wait";
      job.snapshot.status = "error"; job.snapshot.background!.state = "error";
      job.snapshot.error = "A worker was interrupted during a provider request. Its reserved cost is retained. Resume explicitly to retry; no request was repeated automatically.";
      return "stop";
    }
    await client.query("INSERT INTO review_operations (run_id,execution,slot,state,lease_until) VALUES ($1,$2,$3,'running',NOW()+INTERVAL '5 minutes')", [runId, execution, slot]);
    job.snapshot.background!.phase = slot.startsWith("review:") ? `Reviewing ${slot.slice(7)}` : "Synthesizing findings";
    if (slot.startsWith("review:")) {
      const model = job.snapshot.models.find(item => item.id === slot.slice(7));
      if (model) job.snapshot.responses = [...job.snapshot.responses.filter(response => (response.requestedModel ?? response.model) !== model.id),
        { model: model.id, requestedModel: model.id, modelName: model.name, family: model.family, status: "streaming" }];
    }
    return "start";
  });
}
export async function finishOperation(runId: string, execution: number, slot: string, update: (run: RunCheckpoint) => void) {
  return changeJob(runId, execution, async (job, client) => {
    update(job.snapshot);
    await client.query("UPDATE review_operations SET state='done' WHERE run_id=$1 AND execution=$2 AND slot=$3", [runId, execution, slot]);
    if (job.cancelRequested) {
      const pending = await client.query("SELECT 1 FROM review_operations WHERE run_id=$1 AND execution=$2 AND state='running' AND lease_until>NOW()", [runId, execution]);
      job.snapshot.status = "stopped"; job.snapshot.background!.state = pending.rows.length ? "stopping" : "stopped";
    }
  });
}
export async function stopBackgroundReview(runId: string, owner: string) {
  await initBackgroundDb();
  return transaction(async client => {
    const job = await lockJob(client, runId);
    if (job.owner !== owner) throw new ReviewConflict("Review not found");
    if (!["queued", "running", "stopping"].includes(job.snapshot.background!.state)) return;
    const pending = await client.query("SELECT 1 FROM review_operations WHERE run_id=$1 AND execution=$2 AND state='running' AND lease_until>NOW()", [runId, job.execution]);
    job.cancelRequested = true; job.snapshot.status = "stopped";
    job.snapshot.background!.state = pending.rows.length ? "stopping" : "stopped";
    job.snapshot.background!.phase = pending.rows.length ? "Stopping active request" : "Stopped";
    job.snapshot.error = "Stopped. Completed answers and spending are saved. A provider may still bill an accepted request.";
    await writeJob(client, job);
  });
}
export async function setJobState(runId: string, execution: number, state: JobState, error?: string) {
  return changeJob(runId, execution, async job => {
    if (job.cancelRequested && state === "complete") return;
    job.snapshot.background!.state = state;
    job.snapshot.background!.phase = state === "complete" ? "Review complete" : state;
    job.snapshot.status = state === "queued" ? "running" : state === "stopping" ? "stopped" : state;
    job.snapshot.error = error;
  });
}

export async function recoverStalledReview(runId: string, owner: string) {
  await initBackgroundDb();
  await transaction(async client => {
    const stale = await client.query(`SELECT 1 FROM review_jobs j WHERE run_id=$1 AND owner_key=$2
      AND state IN ('queued','running','stopping') AND updated_at < NOW()-INTERVAL '6 minutes'
      AND NOT EXISTS (SELECT 1 FROM review_operations o WHERE o.run_id=j.run_id AND o.execution=j.execution AND o.state='running' AND o.lease_until>NOW()) FOR UPDATE OF j`, [runId, owner]);
    if (!stale.rows.length) return;
    const job = await lockJob(client, runId);
    job.snapshot.status = job.cancelRequested ? "stopped" : "error";
    job.snapshot.background!.state = job.cancelRequested ? "stopped" : "error";
    job.snapshot.error = "The worker stopped responding. Saved answers and reserved costs are retained; resume to continue.";
    await writeJob(client, job);
  });
}

export async function recoverAbandonedReviews() {
  await initBackgroundDb();
  return transaction(async client => {
    const rows = await client.query(`SELECT j.*,r.snapshot FROM review_jobs j JOIN runs r ON r.id=j.run_id
      WHERE j.state IN ('queued','running','stopping') AND j.updated_at<NOW()-INTERVAL '6 minutes'
      AND NOT EXISTS (SELECT 1 FROM review_operations o WHERE o.run_id=j.run_id AND o.execution=j.execution AND o.state='running' AND o.lease_until>NOW())
      LIMIT 50 FOR UPDATE OF j SKIP LOCKED`);
    for (const row of rows.rows) {
      const job = await lockJob(client, String(row.run_id));
      job.snapshot.status = job.cancelRequested ? "stopped" : "error";
      job.snapshot.background!.state = job.cancelRequested ? "stopped" : "error";
      job.snapshot.error = "The background worker stopped responding. Saved answers and reserved costs are retained; resume to continue.";
      await writeJob(client, job);
    }
    await client.query("UPDATE review_jobs SET credential=NULL WHERE credential_expires<NOW() AND credential IS NOT NULL");
    return rows.rowCount;
  });
}

/** Every reservation and settlement is serialized on the database's run lock. */
export class PersistentRunBudget extends RunBudget {
  constructor(private runId: string, private execution: number, private modelId: string, limit: number) { super(limit); }
  override async reserve(requestId: string, ceiling: number) {
    await changeJob(this.runId, this.execution, async job => {
      if (job.cancelRequested || !["queued", "running"].includes(job.snapshot.background!.state)) throw new DOMException("Stopped", "AbortError");
      if (job.snapshot.usage.some(usage => usage.requestId === requestId)) throw new ReviewConflict("Request already reserved");
      if (!Number.isFinite(ceiling) || ceiling < 0 || ceiling > job.snapshot.maxCost - checkpointCost(job.snapshot) + 1e-9) throw new BudgetExceededError();
      job.snapshot.usage.push({ requestId, model: this.modelId, inputTokens: 0, outputTokens: 0, cost: ceiling, costSource: "reserved" });
    });
  }
  override async settle(requestId: string, record: ModelUsage) {
    await changeJob(this.runId, this.execution, async job => {
      if (!job.snapshot.usage.some(usage => usage.requestId === requestId)) throw new ReviewConflict("Request reservation missing");
      job.snapshot.usage = job.snapshot.usage.map(usage => usage.requestId === requestId ? record : usage);
    });
  }
  override async release(requestId: string) {
    await changeJob(this.runId, this.execution, async job => { job.snapshot.usage = job.snapshot.usage.filter(usage => usage.requestId !== requestId); });
  }
}
