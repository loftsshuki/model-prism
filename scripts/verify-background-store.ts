import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { BackgroundReviewSchema } from "../src/lib/review-policy";
import { beginOperation, claimWorkflow, finishOperation, loadWorkerJob, PersistentRunBudget, recoverStalledReview, startBackgroundReview, stopBackgroundReview, changeJob } from "../src/lib/server/background-store";
import { getRun, saveRunCheckpoint } from "../src/lib/db";
import { recordFindings, listTrackedFindings, updateFinding, humanModelQuality, initFindingDb } from "../src/lib/server/finding-store";
import { transaction } from "../src/lib/server/database";
import { checkpointCost } from "../src/lib/run-checkpoint";
import { SNAPSHOT_MODELS, SYNTHESIS_IDS } from "../src/lib/model-catalog";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  process.env.MODEL_PRISM_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
  const owner = `verification:${randomUUID()}`, ids: string[] = [];
  const make = (content = "Synthetic database concurrency verification") => {
    const id = `run_verify_${randomUUID()}`; ids.push(id);
    return BackgroundReviewSchema.parse({ id, content, prompt: "No provider invocation", modelIds: SNAPSHOT_MODELS.slice(0, 3).map(model => model.id), synthesisModel: SYNTHESIS_IDS.sonnet, maxCost: 1, projectKey: owner });
  };
  await initFindingDb();
  try {
    const a = make(), b = make();
    const starts = await Promise.all([startBackgroundReview(a, owner, "synthetic-key-no-provider-call", SNAPSHOT_MODELS), startBackgroundReview(b, owner, "synthetic-key-no-provider-call", SNAPSHOT_MODELS)]);
    assert.equal(starts.filter(job => job.started).length, 1, "Identical requests dispatch exactly one job");
    assert.equal(starts[0].id, starts[1].id);
    const id = starts[0].id, execution = starts[0].execution;
    assert.equal(await claimWorkflow(id, execution, "verification-workflow"), true);
    assert.equal(await claimWorkflow(id, execution, "duplicate-workflow"), false);
    assert.equal(await getRun(id, "wrong-owner"), null);
    assert.equal(await getRun(id, null), null);
    assert.equal(await beginOperation(id, execution, "review:a"), "start");
    assert.equal(await beginOperation(id, execution, "review:a"), "wait");
    const budget = new PersistentRunBudget(id, execution, "test-model", 1);
    const reservations = await Promise.allSettled([budget.reserve("request-a", .6), budget.reserve("request-b", .6)]);
    assert.equal(reservations.filter(item => item.status === "fulfilled").length, 1, "Concurrent reservations may not exceed the shared budget");
    let job = await loadWorkerJob(id);
    assert.equal(checkpointCost(job.snapshot), .6);
    const accepted = job.snapshot.usage[0].requestId;
    await budget.settle(accepted, { requestId: accepted, model: "test-model", inputTokens: 1, outputTokens: 1, cost: .2, costSource: "provider" });
    await budget.reserve("request-c", .6);
    job = await loadWorkerJob(id);
    assert.equal(checkpointCost(job.snapshot), .8);
    await assert.rejects(saveRunCheckpoint({ ...job.snapshot, revision: 9999, usage: [] }, owner), /RUN_CONFLICT/);
    await assert.rejects(saveRunCheckpoint({ ...job.snapshot, background: undefined, revision: 9999, usage: [] }, owner), /RUN_CONFLICT/);
    assert.equal(await beginOperation(id, execution, "review:b"), "start");
    await stopBackgroundReview(id, owner);
    assert.equal((await loadWorkerJob(id)).snapshot.background!.state, "stopping");
    await finishOperation(id, execution, "review:a", () => {});
    assert.equal((await loadWorkerJob(id)).snapshot.background!.state, "stopping");
    await finishOperation(id, execution, "review:b", () => {});
    job = await loadWorkerJob(id);
    assert.equal(job.snapshot.background!.state, "stopped"); assert.equal(job.credential, null);
    await assert.rejects(budget.reserve("after-stop", .01));
    const resumed = await startBackgroundReview({ ...a, id }, owner, "synthetic-key-no-provider-call", SNAPSHOT_MODELS);
    assert.equal(resumed.execution, execution + 1);
    await assert.rejects(budget.release(accepted), /newer execution/);
    assert.equal(checkpointCost((await loadWorkerJob(id)).snapshot), .8);
    await transaction(async client => { await client.query("UPDATE review_jobs SET updated_at=NOW()-INTERVAL '7 minutes' WHERE run_id=$1", [id]); });
    await recoverStalledReview(id, owner);
    job = await loadWorkerJob(id);
    assert.equal(job.snapshot.background!.state, "error"); assert.equal(checkpointCost(job.snapshot), .8); assert.equal(job.credential, null);

    await changeJob(id, resumed.execution, async active => {
      active.snapshot.responses = [{ model: "test-model", modelName: "Test model", status: "complete", response: "SELECT * FROM runs omits its owner" }];
      active.snapshot.sources = [{ id: "file:query.ts", path: "query.ts", text: "SELECT * FROM runs" }];
      active.snapshot.synthesis = { masterDocument: "Database test", consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], themeMatrix: [], findings: [{ id: "f1", title: "Missing owner filter", severity: "high", recommendation: "Scope the query", supportingModels: ["model:test-model"], evidence: [{ source: "file:query.ts", quote: "SELECT * FROM runs" }], evidenceVerified: true }] };
    });
    job = await loadWorkerJob(id); await recordFindings(job.snapshot, owner);
    const [finding] = await listTrackedFindings(id, owner);
    await updateFinding({ runId: id, fingerprint: finding.fingerprint, state: "accepted", note: "Synthetic verification" }, owner);
    assert.equal((await listTrackedFindings(id, owner))[0].state, "accepted");
    await assert.rejects(updateFinding({ runId: id, fingerprint: finding.fingerprint, state: "dismissed", note: "" }, "wrong-owner"), /not found/);
    assert.deepEqual(await listTrackedFindings(id, "wrong-owner"), []);
    const next = make("Synthetic second review");
    const submissionId = randomUUID();
    const second = await startBackgroundReview({ ...next, baselineRunId: id }, owner, "synthetic-key-no-provider-call", SNAPSHOT_MODELS, submissionId);
    await changeJob(second.id, second.execution, async active => { active.snapshot.synthesis = job.snapshot.synthesis; active.snapshot.sources = job.snapshot.sources; });
    const nextJob = await loadWorkerJob(second.id); await recordFindings(nextJob.snapshot, owner);
    assert.equal((await listTrackedFindings(second.id, owner, id))[0].change, "recurring");
    assert.equal((await listTrackedFindings(second.id, owner, id))[0].state, "accepted");
    await recordFindings({ ...nextJob.snapshot, synthesis: { ...nextJob.snapshot.synthesis!, findings: [] } }, owner);
    assert.equal((await listTrackedFindings(second.id, owner, id))[0].change, "not_reported");
    assert.equal((await listTrackedFindings(second.id, owner, id))[0].state, "accepted");
    const [quality] = await humanModelQuality(owner);
    assert.equal(quality.confirmed, 1); assert.equal(quality.precision, null); assert.equal(quality.cost, .8);
    await changeJob(second.id, second.execution, async active => { active.snapshot.background!.state = "complete"; active.snapshot.status = "complete"; });
    const replay = await startBackgroundReview({ ...next, baselineRunId: id }, owner, "synthetic-key-no-provider-call", SNAPSHOT_MODELS, submissionId);
    assert.equal(replay.started, false); assert.equal(replay.execution, second.execution);
    await assert.rejects(startBackgroundReview({ ...next, content: "changed", baselineRunId: id }, owner, "synthetic-key-no-provider-call", SNAPSHOT_MODELS, submissionId), /submission ID/);
    console.log("PASS: atomic reservations, duplicate dispatch, private ownership, server-only ledger, stop/resume, stale-worker recovery, encrypted-key cleanup, and persistent finding decisions");
  } finally {
    await transaction(async client => {
      await client.query("DELETE FROM review_findings WHERE owner_key=$1", [owner]);
      await client.query("DELETE FROM runs WHERE id=ANY($1::text[]) AND owner_key=$2", [ids, owner]);
    });
    console.log("Synthetic verification records removed");
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });
