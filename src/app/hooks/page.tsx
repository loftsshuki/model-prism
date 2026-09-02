"use client";

import Link from "next/link";

import { useEffect, useMemo, useState } from "react";
import { authHeaders } from "@/lib/client-api";
import type { ReviewJob } from "@/lib/job-types";
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

const ACTIVE_SERVER_STATUSES = new Set(["queued", "running", "synthesizing"]);

export default function HooksDashboardPage() {
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [jobs, setJobs] = useState<HookJob[]>([]);
  const [serverJobs, setServerJobs] = useState<ReviewJob[]>([]);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // `loading` starts true; polls refresh silently instead of flashing the spinner.
    const load = async () => {
      try {
        const [telemetry, hookJobs, reviewJobs] = await Promise.all([
          fetch("/api/telemetry", { headers: authHeaders() }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
          fetch("/api/hook-jobs", { headers: authHeaders() }).then((r) => r.json()).catch(() => ({ jobs: [] })),
          // Server-side runs (durable jobs advanced by /api/jobs/work); optional like hook jobs.
          fetch("/api/jobs", { headers: authHeaders() }).then((r) => r.json()).catch(() => ({ jobs: [] })),
        ]);
        if (cancelled) return;
        setData(telemetry);
        setJobs(hookJobs.jobs || []);
        setServerJobs(reviewJobs.jobs || []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const interval = window.setInterval(load, 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [refreshTick]);

  const cancelServerJob = async (id: string) => {
    try {
      await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: authHeaders() });
    } catch {
      // The next poll shows the real state either way.
    }
    setRefreshTick((t) => t + 1);
  };

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
            <Link href="/" className="text-xs uppercase tracking-[0.2em] text-neutral-500 hover:text-neutral-300">← Back</Link>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">Plan-Review Hook Dashboard</h1>
            <p className="mt-2 text-sm text-neutral-500">
              Live hook/council activity. Hook workers can POST jobs to <code>/api/hook-jobs</code>; this page refreshes automatically.
            </p>
          </div>
          <button onClick={() => setRefreshTick((t) => t + 1)} className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:border-neutral-600">Refresh</button>
        </header>

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
            Could not load the dashboard: {error}. If an admin token is configured, enter it in Settings.
          </div>
        )}
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

            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="text-lg font-semibold">Server-side runs</h2>
                <p className="text-xs text-neutral-500">
                  Enqueued via <code>POST /api/jobs</code>, advanced one step at a time by <code>/api/jobs/work</code>.
                </p>
              </div>
              <ServerRunsTable jobs={serverJobs} onCancel={cancelServerJob} />
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

function ServerRunsTable({ jobs, onCancel }: { jobs: ReviewJob[]; onCancel: (id: string) => void }) {
  if (jobs.length === 0) {
    return <p className="mt-4 text-sm text-neutral-500">No server-side runs yet.</p>;
  }
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-neutral-500">
            <th className="pb-2 pr-4 font-medium">Job</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 pr-4 font-medium">Phase</th>
            <th className="pb-2 pr-4 font-medium">Models</th>
            <th className="pb-2 pr-4 font-medium">Cost</th>
            <th className="pb-2 pr-4 font-medium">Created</th>
            <th className="pb-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const active = ACTIVE_SERVER_STATUSES.has(job.status);
            const total = job.step.pending.length + job.step.done.length + job.step.failed.length;
            return (
              <tr key={job.id} className="border-t border-neutral-800 align-top">
                <td className="py-2 pr-4">
                  <span className="font-mono text-xs text-neutral-300" title={job.id}>{job.id.slice(0, 16)}…</span>
                  {job.error && <p className="mt-1 max-w-xs text-xs text-red-300" title={job.error}>{job.error.slice(0, 120)}</p>}
                </td>
                <td className="py-2 pr-4"><StatusPill status={job.status} /></td>
                <td className="py-2 pr-4 text-neutral-300">{job.step.phase}</td>
                <td className="py-2 pr-4 text-neutral-300">
                  {job.step.done.length}/{total} done
                  {job.step.failed.length > 0 && <span className="text-red-300"> · {job.step.failed.length} failed</span>}
                  {job.step.pending.length > 0 && <span className="text-neutral-500"> · {job.step.pending.length} pending</span>}
                </td>
                <td className="py-2 pr-4 text-neutral-300">${Number(job.cost || 0).toFixed(4)}</td>
                <td className="py-2 pr-4 text-neutral-500">{new Date(job.created_at).toLocaleString()}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  {job.status === "completed" && (
                    <a href={`/runs/${job.run_id}`} className="text-xs text-violet-300 hover:text-violet-200">Open run →</a>
                  )}
                  {active && (
                    <button onClick={() => onCancel(job.id)} className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-red-500 hover:text-red-300">Cancel</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: ReviewJob["status"] }) {
  const tone = status === "completed" ? "border-emerald-900 text-emerald-300"
    : status === "failed" ? "border-red-900 text-red-300"
    : status === "cancelled" ? "border-neutral-700 text-neutral-400"
    : "border-violet-900 text-violet-300";
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide ${tone}`}>{status}</span>;
}
