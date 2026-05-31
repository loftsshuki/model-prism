"use client";

import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/client-api";
import type { ModelFailureDiagnostic, ModelValueRow, RosterRecommendation } from "@/lib/telemetry";

interface TelemetryResponse {
  telemetryPath: string;
  runCount: number;
  leaderboard: ModelValueRow[];
  diagnostics: ModelFailureDiagnostic[];
  recommendations: RosterRecommendation[];
  error?: string;
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function money(value: number | null) {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

export default function ModelsPage() {
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/telemetry", { headers: authHeaders() });
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-6 py-8">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <a href="/" className="text-xs uppercase tracking-[0.2em] text-neutral-500 hover:text-neutral-300">← Back</a>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">Model Intelligence</h1>
            <p className="mt-2 text-sm text-neutral-500">
              Leaderboard, failure diagnostics, and roster recommendations from the local telemetry ledger.
            </p>
          </div>
          <button onClick={load} className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:border-neutral-600">
            Refresh
          </button>
        </header>

        {loading && <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-400">Loading telemetry…</div>}
        {!loading && data?.error && <div className="rounded-xl border border-red-900 bg-red-950/40 p-6 text-red-300">{data.error}</div>}

        {!loading && data && !data.error && (
          <>
            <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Runs recorded</p>
                <p className="mt-2 text-3xl font-semibold">{data.runCount}</p>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 md:col-span-2">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Telemetry path</p>
                <p className="mt-2 text-sm text-neutral-300 break-all">{data.telemetryPath}</p>
              </div>
            </section>

            {data.runCount === 0 && (
              <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-400">
                No model telemetry yet. Run and synthesize a council review from the home page; Model Prism records one telemetry row after synthesis succeeds.
              </div>
            )}

            {data.recommendations.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">Roster Recommendations</h2>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {data.recommendations.map((item) => (
                    <div key={item.id} className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-neutral-100">{item.modelName}</p>
                        <span className="rounded-full bg-neutral-800 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-300">{item.type}</span>
                      </div>
                      <p className="mt-2 text-sm text-neutral-500">{item.reason}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {data.diagnostics.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">Failure Diagnostics</h2>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {data.diagnostics.map((item) => (
                    <div key={item.id} className="rounded-xl border border-red-950 bg-red-950/20 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-red-100">{item.name}</p>
                        <span className="rounded-full bg-red-950 px-2 py-1 text-[11px] uppercase tracking-wide text-red-300">{item.severity}</span>
                      </div>
                      <p className="mt-2 text-sm text-red-200/70">{item.message}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Leaderboard</h2>
              <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-950/70 text-xs uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="px-4 py-3 text-left">Model</th>
                      <th className="px-4 py-3 text-right">Value</th>
                      <th className="px-4 py-3 text-right">Success</th>
                      <th className="px-4 py-3 text-right">Unique/run</th>
                      <th className="px-4 py-3 text-right">Coverage</th>
                      <th className="px-4 py-3 text-right">Cost</th>
                      <th className="px-4 py-3 text-left">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {data.leaderboard.map((row) => (
                      <tr key={row.id} className="hover:bg-neutral-800/40">
                        <td className="px-4 py-3">
                          <div className="font-medium text-neutral-100">{row.name}</div>
                          <div className="text-xs text-neutral-500">{row.family} · {row.tier} · {row.appearances} runs</div>
                        </td>
                        <td className="px-4 py-3 text-right text-neutral-300">{row.valueScore.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right text-neutral-300">{pct(row.successRate)}</td>
                        <td className="px-4 py-3 text-right text-neutral-300">{row.uniquePerRun.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right text-neutral-300">{row.themeAvg === null ? "—" : row.themeAvg.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right text-neutral-300">{money(row.totalCost)}</td>
                        <td className="px-4 py-3 text-neutral-300">{row.verdict}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
