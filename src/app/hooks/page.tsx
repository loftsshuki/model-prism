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

interface HookJob {
  id: string;
  plan_file: string;
  status: "pending" | "running" | "completed" | "failed" | string;
  run_id?: string | null;
  cost?: number | null;
  models?: string | null;
  error?: string | null;
  logs?: string | null;
  created_at: string;
  updated_at: string;
}

export default function HooksDashboardPage() {
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [jobs, setJobs] = useState<HookJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [telemetry, hookJobs] = await Promise.all([
      fetch("/api/telemetry", { headers: authHeaders() }).then((r) => r.json()),
      fetch("/api/hook-jobs", { headers: authHeaders() }).then((r) => r.json()).catch(() => ({ jobs: [] })),
    ]);
    setData(telemetry);
    setJobs(hookJobs.jobs || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 15000);
    return () => window.clearInterval(interval);
  }, []);

  const stats = useMemo(() => {
    const models = data?.leaderboard || [];
    return {
      completed: jobs.filter((job) => job.status === "completed").length || data?.runCount || 0,
      pending: jobs.filter((job) => job.status === "pending").length,
      running: jobs.filter((job) => job.status === "running").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      failedModels: models.reduce((sum, model) => sum + model.errors, 0),
      totalCost: models.reduce((sum, model) => sum + model.totalCost, 0) + jobs.reduce((sum, job) => sum + Number(job.cost || 0), 0),
      modelsUsed: models.length,
    };
  }, [data, jobs]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <a href="/" className="text-xs uppercase tracking-[0.2em] text-neutral-500 hover:text-neutral-300">← Back</a>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">Plan-Review Hook Dashboard</h1>
            <p className="mt-2 text-sm text-neutral-500">
              Live hook/council activity. Hook workers can POST jobs to <code>/api/hook-jobs</code>; this page refreshes automatically.
            </p>
          </div>
          <button onClick={load} className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:border-neutral-600">Refresh</button>
        </header>

        {loading ? (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-400">Loading dashboard…</div>
        ) : (
          <>
            <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Metric label="Pending" value={stats.pending} />
              <Metric label="Running" value={stats.running} />
              <Metric label="Completed" value={stats.completed} />
              <Metric label="Failed" value={stats.failed} />
            </section>

            <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Metric label="Models tracked" value={stats.modelsUsed} />
              <Metric label="Model failures" value={stats.failedModels} />
              <Metric label="Tracked cost" value={`$${stats.totalCost.toFixed(4)}`} />
              <Metric label="Telemetry runs" value={data?.runCount || 0} />
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-4 gap-4">
              <StatusColumn title="Pending" jobs={jobs.filter((job) => job.status === "pending")} empty="No pending hook reviews." />
              <StatusColumn title="Running" jobs={jobs.filter((job) => job.status === "running")} empty="No reviews running." />
              <StatusColumn title="Completed" jobs={jobs.filter((job) => job.status === "completed")} empty="No completed hook jobs yet." />
              <StatusColumn title="Failed" jobs={jobs.filter((job) => job.status === "failed")} empty="No failed hook jobs." />
            </section>

            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 space-y-3">
              <h2 className="text-lg font-semibold">Hook worker contract</h2>
              <pre className="overflow-x-auto rounded-lg bg-neutral-950 p-4 text-xs text-neutral-400">{`POST /api/hook-jobs
{
  "id": "plan-file-hash-or-job-id",
  "planFile": "docs/plans/my-plan.md",
  "status": "pending | running | completed | failed",
  "runId": "optional-model-prism-run-id",
  "cost": 0.1234,
  "models": ["model-a", "model-b"],
  "error": "optional failure text",
  "logs": "optional log excerpt"
}`}</pre>
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

function StatusColumn({ title, jobs, empty }: { title: string; jobs: HookJob[]; empty: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 min-h-44">
      <h2 className="text-sm font-semibold text-neutral-300">{title}</h2>
      {jobs.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">{empty}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {jobs.slice(0, 8).map((job) => (
            <div key={job.id} className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
              <p className="truncate text-sm text-neutral-200" title={job.plan_file}>{job.plan_file}</p>
              <p className="mt-1 text-[11px] text-neutral-500">{new Date(job.updated_at).toLocaleString()}</p>
              {job.run_id && <a href={`/runs/${job.run_id}`} className="mt-2 block text-xs text-violet-300 hover:text-violet-200">Open run →</a>}
              {job.error && <p className="mt-2 text-xs text-red-300">{job.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
