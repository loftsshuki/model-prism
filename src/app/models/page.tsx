"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/client-api";
import type { ModelFailureDiagnostic, ModelValueRow } from "@/lib/telemetry";
import type { HumanModelQuality } from "@/lib/server/finding-store";
import type { FreshnessReport } from "@/lib/server/freshness-store";

const money = (value: number | null) => value === null ? "—" : `$${value.toFixed(4)}`;
type Telemetry = { runCount: number; leaderboard: ModelValueRow[]; diagnostics: ModelFailureDiagnostic[] };

export default function ModelsPage() {
  const [quality, setQuality] = useState<HumanModelQuality[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [freshness, setFreshness] = useState<FreshnessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [freshnessError, setFreshnessError] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  async function load() {
    setLoading(true);
    const results = await Promise.allSettled([
      fetch("/api/quality", { headers: authHeaders() }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to load confirmed outcomes"); return data; }),
      fetch("/api/telemetry", { headers: authHeaders() }).then(response => response.json()),
      fetch("/api/model-health").then(response => response.json()),
    ]);
    const [outcomes, signals, health] = results;
    if (outcomes.status === "fulfilled") { setQuality(outcomes.value.models ?? []); setError(""); }
    else setError(outcomes.reason?.message ?? "Unable to load outcomes");
    if (signals.status === "fulfilled") setTelemetry(signals.value);
    if (health.status === "fulfilled") { setFreshness(health.value.report ?? null); setFreshnessError(health.value.error ?? ""); }
    else setFreshnessError("The scheduled check status is unavailable");
    setLoading(false);
    setLoadedAt(Date.now());
  }
  useEffect(() => { queueMicrotask(() => { void load(); }); }, []);
  const stale = freshness && loadedAt - Date.parse(freshness.checkedAt) > 36 * 60 * 60 * 1000;
  return <main className="min-h-screen bg-cream text-ink px-4 sm:px-6 py-8">
    <div className="max-w-6xl mx-auto space-y-7">
      <header className="flex items-start justify-between gap-4">
        <div><Link href="/" className="text-sm text-green underline">← Back</Link><h1 className="mt-4 font-display text-3xl">Model performance</h1><p className="mt-2 text-sm text-grey-50">Useful findings confirmed by you, alongside costs and reliability.</p></div>
        <button disabled={loading} onClick={load} className="min-h-11 border border-border px-4 py-2 text-sm text-green">{loading ? "Loading…" : "Refresh"}</button>
      </header>
      <section className="border border-border bg-white p-5 space-y-3">
        <h2 className="font-display text-xl">Daily model freshness</h2>
        <p className="text-sm">{freshness ? `${freshness.configured} configured models · ${freshness.status === "failed" ? "Check failed" : freshness.status === "attention" ? "Changes need review" : "Metadata matches"} · ${new Date(freshness.checkedAt).toLocaleString()}` : freshnessError || "The first scheduled check has not been recorded yet."}</p>
        {stale && <p role="status" className="text-sm text-amber-900">The scheduled check is overdue. Every new paid review still checks the live catalog before starting.</p>}
        {freshness?.error && <p className="text-sm text-amber-900">{freshness.error}</p>}
        {!!freshness?.findings.length && <ul className="space-y-2 text-xs">{freshness.findings.map((finding, index) => <li key={`${finding.id}:${index}`} className="break-words"><strong>{finding.kind}</strong> · {finding.id} · {finding.detail}</li>)}</ul>}
        <p className="text-xs text-grey-50">Vercel checks daily. Live prices and capabilities are used for reviews; newly released model IDs require evaluation before joining a curated council.</p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-2xl">Confirmed outcomes</h2>
        <p className="text-xs text-grey-50">Accepted and fixed findings count as useful. Only findings explicitly dismissed as false positives count as false positives. Attribution uses the synthesis’s listed supporters; this is observational feedback, not a controlled model benchmark.</p>
        {error && <p role="status" className="border border-gold p-4 text-sm">{error}</p>}
        {!loading && !error && !quality.length && <p className="border border-border bg-white p-5 text-sm">No confirmed outcomes yet. Open a saved review and record your finding decisions.</p>}
        {!!quality.length && <div className="overflow-x-auto border border-border bg-white"><table className="w-full text-sm">
          <thead className="bg-cream"><tr>{["Model", "Confirmed", "False positives", "Precision", "Recorded cost", "Cost / useful finding"].map(label => <th key={label} className="px-4 py-3 text-left whitespace-nowrap font-medium">{label}</th>)}</tr></thead>
          <tbody>{quality.map(row => <tr key={row.model} className="border-t border-border"><td className="px-4 py-3 break-words min-w-44">{row.model}</td><td className="px-4 py-3">{row.confirmed}</td><td className="px-4 py-3">{row.falsePositives}</td><td className="px-4 py-3 whitespace-nowrap">{row.precision === null ? `Need ${Math.max(0, 5 - row.reviewed)} more decisions` : `${Math.round(row.precision * 100)}% (${row.reviewed})`}</td><td className="px-4 py-3">{money(row.cost)}</td><td className="px-4 py-3">{money(row.costPerConfirmed)}</td></tr>)}</tbody>
        </table></div>}
        <p className="text-xs text-grey-50">Precision appears after five judged findings. Spending includes failed attempts, synthesis, estimates, and unresolved reservations. Repeated occurrences of the same finding count once per project and model.</p>
      </section>
      {!!telemetry?.diagnostics?.length && <section className="space-y-3"><h2 className="font-display text-xl">Reliability concerns</h2><div className="grid gap-3 sm:grid-cols-2">{telemetry.diagnostics.map(item => <article key={item.id} className="border border-gold bg-white p-4"><h3 className="text-sm font-medium">{item.name}</h3><p className="text-sm mt-2 text-grey-60">{item.message}</p></article>)}</div></section>}
      <details className="border border-border bg-white p-5"><summary className="cursor-pointer text-sm font-medium">Model-assessed signals · {telemetry?.runCount ?? 0} reviews</summary><p className="my-3 text-xs text-grey-50">Coverage and uniqueness were assigned by a synthesizer. They are useful diagnostics and do not establish correctness or determine your default council.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{["Model", "Completed", "Unique / run", "Coverage", "Cost"].map(label => <th className="text-left p-3 whitespace-nowrap" key={label}>{label}</th>)}</tr></thead><tbody>{(telemetry?.leaderboard ?? []).map(row => <tr key={row.id} className="border-t border-border"><td className="p-3">{row.name}</td><td className="p-3">{Math.round(row.successRate * 100)}%</td><td className="p-3">{row.uniquePerRun.toFixed(2)}</td><td className="p-3">{row.themeAvg?.toFixed(2) ?? "—"}</td><td className="p-3">{money(row.totalCost)}</td></tr>)}</tbody></table></div>
      </details>
    </div>
  </main>;
}
