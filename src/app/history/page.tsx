"use client";

import { useEffect, useState } from "react";

interface RunSummary {
  id: string;
  content: string;
  prompt: string;
  total_cost: number;
  created_at: string;
  response_count: number;
  has_synthesis: number;
}

export default function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => r.json())
      .then((data) => {
        setRuns(data.runs || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                <span className="text-sm font-bold">P</span>
              </div>
              <h1 className="text-lg font-semibold">Model Prism</h1>
            </a>
            <span className="text-neutral-600">/</span>
            <span className="text-sm text-neutral-400">History</span>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        {loading && (
          <div className="text-center text-neutral-600 py-12">Loading...</div>
        )}

        {!loading && runs.length === 0 && (
          <div className="text-center text-neutral-600 py-12">
            No runs yet. <a href="/" className="text-violet-400 hover:underline">Start your first analysis.</a>
          </div>
        )}

        {runs.length > 0 && (
          <div className="space-y-2">
            {runs.map((run) => (
              <a
                key={run.id}
                href={`/runs/${run.id}`}
                className="block rounded-lg border border-neutral-800 bg-neutral-900 p-4 hover:border-neutral-700 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-neutral-200 line-clamp-1">
                      {run.prompt}
                    </p>
                    <p className="text-xs text-neutral-500 mt-1 line-clamp-1">
                      {run.content}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 shrink-0 text-xs text-neutral-500">
                    <span>{run.response_count} models</span>
                    {run.has_synthesis > 0 && (
                      <span className="text-violet-400">synthesized</span>
                    )}
                    <span>{new Date(run.created_at + "Z").toLocaleDateString()}</span>
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
