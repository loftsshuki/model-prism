import { configuredModelIds, fetchModelCatalog } from "../model-catalog";
import { checkModelFreshness, type FreshnessFinding } from "../model-freshness";
import { initBackgroundDb } from "./background-store";
import { transaction } from "./database";

export interface FreshnessReport { checkedAt: string; status: "ok" | "attention" | "failed"; configured: number; findings: FreshnessFinding[]; error?: string }
export async function checkAndSaveFreshness(): Promise<FreshnessReport> {
  await initBackgroundDb();
  let report: FreshnessReport;
  try {
    const models = await fetchModelCatalog();
    const findings = checkModelFreshness(models);
    report = { checkedAt: new Date().toISOString(), status: findings.length ? "attention" : "ok", configured: configuredModelIds().length, findings };
  } catch {
    report = { checkedAt: new Date().toISOString(), status: "failed", configured: configuredModelIds().length, findings: [], error: "The live provider catalog could not be reached" };
  }
  await transaction(async client => { await client.query(`INSERT INTO model_freshness_checks (id,checked_at,report) VALUES (1,$1,$2::jsonb)
    ON CONFLICT (id) DO UPDATE SET checked_at=EXCLUDED.checked_at, report=EXCLUDED.report`, [report.checkedAt, JSON.stringify(report)]); });
  return report;
}
export async function readFreshness(): Promise<FreshnessReport | null> {
  await initBackgroundDb();
  return transaction(async client => (await client.query("SELECT report FROM model_freshness_checks WHERE id=1")).rows[0]?.report ?? null);
}
