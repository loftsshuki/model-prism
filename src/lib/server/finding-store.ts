import { createHash } from "node:crypto";
import { compareFindings, evidenceLocations, findingIdentity, type DismissalReason, type FindingState, type TrackedFinding } from "../finding-tracking";
import type { RunCheckpoint } from "../run-checkpoint";
import { initBackgroundDb, ReviewConflict } from "./background-store";
import { transaction } from "./database";
import { validateSynthesis } from "../synthesis";

let ready: Promise<void> | undefined;
async function initialize() {
  await initBackgroundDb();
  await transaction(async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS review_findings (
      owner_key TEXT NOT NULL, project_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', dismissal_reason TEXT, note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(owner_key,project_key,fingerprint))`);
    await client.query(`CREATE TABLE IF NOT EXISTS review_finding_occurrences (
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
      owner_key TEXT NOT NULL, project_key TEXT NOT NULL, finding JSONB NOT NULL, locations JSONB NOT NULL,
      PRIMARY KEY (run_id,fingerprint))`);
  });
}
export async function initFindingDb() { ready ??= initialize().catch(error => { ready = undefined; throw error; }); return ready; }

export async function recordFindings(run: RunCheckpoint, owner: string) {
  await initFindingDb();
  const synthesis = run.secondPass ?? run.synthesis;
  const sources = { content: run.content, context: run.context,
    ...Object.fromEntries(run.responses.map(response => [`model:${response.model}`, response.response ?? ""])),
    ...Object.fromEntries((run.sources ?? []).filter(source => source.id.startsWith("file:")).map(source => [source.id, source.text])) };
  const findings = synthesis ? validateSynthesis(synthesis, sources).findings ?? [] : [];
  const project = run.projectKey ?? "default";
  await transaction(async client => {
    // Replacing a synthesis updates occurrences, while human decisions remain intact.
    await client.query("DELETE FROM review_finding_occurrences WHERE run_id=$1 AND owner_key=$2", [run.id, owner]);
    for (const finding of findings) {
      const locations = evidenceLocations(finding, run.sources ?? []);
      const fingerprint = createHash("sha256").update(findingIdentity(finding, locations)).digest("hex").slice(0, 32);
      await client.query(`INSERT INTO review_findings (owner_key,project_key,fingerprint) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [owner, project, fingerprint]);
      await client.query(`INSERT INTO review_finding_occurrences (run_id,fingerprint,owner_key,project_key,finding,locations) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
        ON CONFLICT (run_id,fingerprint) DO UPDATE SET finding=EXCLUDED.finding,locations=EXCLUDED.locations`, [run.id, fingerprint, owner, project, JSON.stringify(finding), JSON.stringify(locations)]);
    }
  });
}
export async function listTrackedFindings(runId: string, owner: string, baselineRunId?: string): Promise<TrackedFinding[]> {
  await initFindingDb();
  const read = (id: string) => transaction(async client => {
    const result = await client.query(`SELECT o.fingerprint,o.finding,o.locations,f.state,f.dismissal_reason,f.note,f.updated_at
      FROM review_finding_occurrences o JOIN review_findings f USING (owner_key,project_key,fingerprint)
      WHERE o.run_id=$1 AND o.owner_key=$2 ORDER BY o.fingerprint`, [id, owner]);
    return result.rows.map(row => ({ fingerprint: row.fingerprint, finding: row.finding, locations: row.locations,
      state: row.state, dismissalReason: row.dismissal_reason ?? undefined, note: row.note,
      change: "new" as const, updatedAt: new Date(row.updated_at).toISOString() } as TrackedFinding));
  });
  const current = await read(runId);
  return baselineRunId ? compareFindings(current, await read(baselineRunId)) : current;
}
export async function updateFinding(input: { runId: string; fingerprint: string; state: FindingState; dismissalReason?: DismissalReason; note: string }, owner: string) {
  await initFindingDb();
  return transaction(async client => {
    const result = await client.query(`UPDATE review_findings f SET state=$4,dismissal_reason=$5,note=$6,updated_at=NOW()
      FROM review_finding_occurrences o WHERE o.run_id=$1 AND o.fingerprint=$2 AND o.owner_key=$3
      AND f.owner_key=o.owner_key AND f.project_key=o.project_key AND f.fingerprint=o.fingerprint RETURNING f.fingerprint`,
    [input.runId, input.fingerprint, owner, input.state, input.state === "dismissed" ? input.dismissalReason ?? "other" : null, input.note]);
    if (!result.rows.length) throw new ReviewConflict("Finding not found");
  });
}

export interface HumanModelQuality { model: string; confirmed: number; falsePositives: number; reviewed: number; precision: number | null; cost: number; costPerConfirmed: number | null }
export async function humanModelQuality(owner: string): Promise<HumanModelQuality[]> {
  await initFindingDb();
  return transaction(async client => {
    const evidence = await client.query(`SELECT DISTINCT o.project_key,o.fingerprint,o.finding,f.state,f.dismissal_reason
      FROM review_finding_occurrences o JOIN review_findings f USING (owner_key,project_key,fingerprint) WHERE o.owner_key=$1`, [owner]);
    const spending = await client.query("SELECT snapshot->'usage' AS usage FROM runs WHERE owner_key=$1 AND snapshot IS NOT NULL", [owner]);
    const rows = new Map<string, HumanModelQuality>();
    const seen = new Set<string>();
    const rowFor = (model: string) => {
      if (!rows.has(model)) rows.set(model, { model, confirmed: 0, falsePositives: 0, reviewed: 0, precision: null, cost: 0, costPerConfirmed: null });
      return rows.get(model)!;
    };
    for (const occurrence of evidence.rows) for (const reference of occurrence.finding.supportingModels ?? []) {
      if (typeof reference !== "string" || !reference.startsWith("model:")) continue;
      const model = reference.slice(6), key = JSON.stringify([occurrence.project_key, occurrence.fingerprint, model]);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = rowFor(model);
      if (["accepted", "fixed"].includes(occurrence.state)) { row.confirmed++; row.reviewed++; }
      if (occurrence.state === "dismissed" && occurrence.dismissal_reason === "false_positive") { row.falsePositives++; row.reviewed++; }
    }
    const charged = new Set<string>();
    for (const run of spending.rows) for (const usage of run.usage ?? []) {
      if (charged.has(usage.requestId)) continue;
      charged.add(usage.requestId); rowFor(usage.model).cost += Number(usage.cost) || 0;
    }
    return [...rows.values()].map(row => ({ ...row, precision: row.reviewed >= 5 ? row.confirmed / row.reviewed : null, costPerConfirmed: row.confirmed ? row.cost / row.confirmed : null }))
      .sort((a, b) => b.confirmed - a.confirmed || a.model.localeCompare(b.model));
  });
}
