"use client";

import { useEffect, useMemo, useState } from "react";
import { authHeaders } from "@/lib/client-api";
import type { ModelValueRow, RosterRecommendation } from "@/lib/telemetry";

interface TelemetryResponse {
  runCount: number;
  leaderboard: ModelValueRow[];
  recommendations: RosterRecommendation[];
  telemetryPath: string;
}

export default function HooksDashboardPage() {
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/telemetry", { headers: authHeaders() })
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => {
    const models = data?.leaderboard || [];
    return {
      completed: data?.runCount || 0,
      failedModels: models.reduce((sum, model) => sum + model.errors, 0),
      totalCost: models.reduce((sum, model) => sum + model.totalCost, 0),
      modelsUsed: models.length,
    };
  }, [data]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <header>
          <a href="/" className="text-xs uppercase tracking-[0.2em] text-neutral-500 hover:text-neutral-300">← Back</a>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">Plan-Review Hook Dashboard</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Lightweight cockpit for council/hook activity. Today it summarizes completed Model Prism reviews; future hook runners can post pending/running jobs here.
          </p>
        </header>

        {loading ? (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-400">Loading dashboard…</div>
        ) : (
          <>
            <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Metric label="Completed reviews" value={stats.completed} />
              <Metric label="Models tracked" value={stats.modelsUsed} />
              <Metric label="Model failures" value={stats.failedModels} />
              <Metric label="Tracked cost" value={`$${stats.totalCost.toFixed(4)}`} />
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <StatusColumn title="Pending" empty="No pending hook reviews." />
              <StatusColumn title="Running" empty="No reviews running." />
              <StatusColumn title="Completed" empty={stats.completed ? `${stats.completed} completed reviews are available in History and Models.` : "No completed reviews yet."} />
            </section>

            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 space-y-3">
              <h2 className="text-lg font-semibold">Manual hook integration checklist</h2>
              <ul className="space-y-2 text-sm text-neutral-400">
                <li>- Use Model Prism for review before executing critical plans.</li>
                <li>- Keep hook execution manual/approved until trust controls are stronger.</li>
                <li>- Export frontmatter from run detail pages for reviewed plans.</li>
                <li>- Revisit this dashboard when adding background hook workers.</li>
              </ul>
            </section>

            {data?.recommendations?.length ? (
              <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
                <h2 className="text-lg font-semibold mb-3">Current roster recommendations</h2>
                <div className="space-y-2">
                  {data.recommendations.slice(0, 5).map((item) => (
                    <div key={item.id} className="border border-neutral-800 rounded-lg p-3 text-sm">
                      <span className="text-neutral-100 font-medium">{item.modelName}</span>
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-neutral-500">{item.type}</span>
                      <p className="mt-1 text-neutral-500">{item.reason}</p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function StatusColumn({ title, empty }: { title: string; empty: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 min-h-40">
      <h2 className="text-sm font-semibold text-neutral-300">{title}</h2>
      <p className="mt-4 text-sm text-neutral-500">{empty}</p>
    </div>
  );
}
