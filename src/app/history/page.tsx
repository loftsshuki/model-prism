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

function formatDate(raw: string) {
  try {
    const d = new Date(raw.includes("T") ? raw : raw + "Z");
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: now.getFullYear() !== d.getFullYear() ? "numeric" : undefined });
  } catch { return ""; }
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
    <div className="min-h-screen bg-cream text-ink">
      <header className="bg-green text-cream">
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="flex items-center gap-4 hover:opacity-80 transition-opacity">
              <div className="w-9 h-9 border border-cream/30 flex items-center justify-center">
                <span className="font-display text-lg font-bold tracking-tight">P</span>
              </div>
              <div>
                <h1 className="font-display text-xl font-bold tracking-tight leading-none">Model Prism</h1>
                <p className="text-[10px] tracking-[0.2em] uppercase text-cream/50 mt-0.5">One Input, Many Angles</p>
              </div>
            </a>
          </div>
          <nav className="flex items-center gap-6">
            <a href="/" className="cta-text text-cream/60 hover:text-cream transition-colors duration-300">New Run</a>
            <span className="cta-text text-cream">History</span>
          </nav>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-px bg-green" />
          <span className="overline text-green">Past Runs</span>
        </div>

        {loading && (
          <div className="text-center text-grey-40 py-12">Loading...</div>
        )}

        {!loading && runs.length === 0 && (
          <div className="text-center text-grey-40 py-12">
            No runs yet. <a href="/" className="text-green hover:underline">Start your first analysis.</a>
          </div>
        )}

        {runs.length > 0 && (
          <div className="space-y-2">
            {runs.map((run) => (
              <a
                key={run.id}
                href={`/runs/${run.id}`}
                className="block border border-border bg-white p-4 hover:border-green/30 transition-colors duration-300"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ink line-clamp-1 font-medium">
                      {run.prompt}
                    </p>
                    <p className="text-xs text-grey-40 mt-1 line-clamp-1">
                      {run.content}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 ml-4 shrink-0">
                    <span className="text-[10px] tracking-wide uppercase text-grey-40">{run.response_count} models</span>
                    {run.has_synthesis > 0 && (
                      <span className="text-[10px] tracking-wide uppercase text-gold">synthesized</span>
                    )}
                    {run.total_cost > 0 && (
                      <span className="text-[10px] tracking-wide text-grey-30">${run.total_cost.toFixed(4)}</span>
                    )}
                    <span className="text-[10px] tracking-wide text-grey-30">{formatDate(run.created_at)}</span>
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
