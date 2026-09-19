import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { accountOwner } from "../src/lib/account-identity";
import { getRun } from "../src/lib/db";
import { BackgroundReviewSchema } from "../src/lib/review-policy";
import { SNAPSHOT_MODELS, COUNCIL_IDS, SYNTHESIS_IDS } from "../src/lib/model-catalog";
import { startBackgroundReview, stopBackgroundReview } from "../src/lib/server/background-store";
import { initAccountDb, importKeyHistory, legacyOwnerIsClaimed, previewHistoryImport, recoverUnownedHistory } from "../src/lib/server/account-store";

async function main() {
  process.loadEnvFile(".env.local");
  const sql = neon(process.env.DATABASE_URL!);
  const legacy = createHash("sha256").update(randomUUID()).digest("hex");
  const owner = accountOwner("user_" + randomUUID().replaceAll("-", ""));
  const other = accountOwner("user_" + randomUUID().replaceAll("-", ""));
  const id = "run_account_test_" + randomUUID();
  const unowned = "run_unowned_test_" + randomUUID();
  const fingerprint = randomUUID().replaceAll("-", "");
  const input = BackgroundReviewSchema.parse({ id, content: "Synthetic account migration", prompt: "Test", modelIds: COUNCIL_IDS.balanced.slice(0, 2), synthesisModel: SYNTHESIS_IDS.sonnet, maxCost: 1 });
  await initAccountDb();
  try {
    await startBackgroundReview(input, legacy, "sk-or-synthetic", SNAPSHOT_MODELS);
    await assert.rejects(importKeyHistory(owner, legacy), /finish or stop/);
    assert.equal(await legacyOwnerIsClaimed(legacy), false);
    await stopBackgroundReview(id, legacy);
    await sql`INSERT INTO review_findings (owner_key,project_key,fingerprint,state,note) VALUES (${legacy},'default',${fingerprint},'accepted','Preserve this decision')`;
    await sql`INSERT INTO review_finding_occurrences (run_id,owner_key,project_key,fingerprint,finding,locations) VALUES (${id},${legacy},'default',${fingerprint},'{}','[]')`;
    await sql`INSERT INTO runs (id,content,prompt,models) VALUES (${unowned},'Synthetic unowned','Test','[]')`;
    assert.equal((await previewHistoryImport(owner, legacy)).reviews, 1);
    const outcomes = await Promise.allSettled([importKeyHistory(owner, legacy), importKeyHistory(other, legacy)]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    const winner = outcomes[0].status === "fulfilled" ? owner : other;
    const loser = winner === owner ? other : owner;
    assert(await getRun(id, winner)); assert.equal(await getRun(id, loser), null); assert.equal(await getRun(id, legacy), null);
    assert.equal(await legacyOwnerIsClaimed(legacy), true);
    assert.equal((await importKeyHistory(winner, legacy)).reviews, 0);
    const [decision] = await sql`SELECT state,note FROM review_findings WHERE owner_key=${winner} AND fingerprint=${fingerprint}`;
    assert.equal(decision.state, "accepted"); assert.equal(decision.note, "Preserve this decision");
    await assert.rejects(startBackgroundReview({ ...input, id: "run_" + randomUUID() }, legacy, "sk-or-synthetic", SNAPSHOT_MODELS), /Sign in/);
    assert.equal(await getRun(unowned, winner), null);
    assert.equal((await recoverUnownedHistory(winner, [unowned], false)).pending, 1);
    assert.equal(await getRun(unowned, winner), null);
    assert.equal((await recoverUnownedHistory(winner, [unowned], true)).recovered, 1);
    await assert.rejects(recoverUnownedHistory(loser, [unowned], true), /another owner/);
    console.log("PASS: concurrent import isolation, active-job protection, decision preservation, revoked legacy capabilities, idempotent imports, selected unowned recovery and dry-run safety");
  } finally {
    await sql`DELETE FROM runs WHERE id IN (${id},${unowned})`;
    await sql`DELETE FROM review_findings WHERE owner_key IN (${legacy},${owner},${other})`;
    await sql`DELETE FROM account_history_imports WHERE legacy_owner=${legacy}`;
    await sql`DELETE FROM account_recovery_audit WHERE account_owner IN (${owner},${other})`;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
