"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { SynthesisResult } from "@/lib/types";
import { SynthesisView } from "@/components/synthesis-view";
import { ResponseCard } from "@/components/response-card";

interface SavedRun {
  id: string;
  content: string;
  prompt: string;
  total_cost: number;
  created_at: string;
  responses: Array<{
    model: string;
    model_name: string;
    response: string | null;
    error: string | null;
    time_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cost: number | null;
  }>;
  synthesis: SynthesisResult | null;
  synthesisModel: string | null;
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<SavedRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/runs/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Run not found");
        return r.json();
      })
      .then((data) => {
        setRun(data.run);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center text-neutral-600">
        Loading...
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center text-neutral-600">
        {error || "Run not found"}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                <span className="text-sm font-bold">P</span>
              </div>
              <h1 className="text-lg font-semibold">Model Prism</h1>
            </a>
            <span className="text-neutral-600">/</span>
            <span className="text-sm text-neutral-400">Run</span>
          </div>
          <a href="/history" className="text-xs text-neutral-500 hover:text-neutral-300">
            History
          </a>
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Run Info */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-sm text-neutral-200 mb-2">{run.prompt}</p>
          <p className="text-xs text-neutral-500 line-clamp-3">{run.content}</p>
          <div className="flex gap-4 mt-3 text-xs text-neutral-600">
            <span>{run.responses.length} models</span>
            <span>{new Date(run.created_at + "Z").toLocaleString()}</span>
            {run.synthesisModel && <span>Synthesized with {run.synthesisModel}</span>}
          </div>
        </div>

        {/* Synthesis */}
        {run.synthesis && <SynthesisView synthesis={run.synthesis} />}

        {/* Responses */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-neutral-400">
            Individual Responses
          </h3>
          {run.responses.map((r) => (
            <ResponseCard
              key={r.model}
              response={{
                model: r.model,
                modelName: r.model_name || r.model,
                status: r.error ? "error" : "complete",
                response: r.response ?? undefined,
                error: r.error ?? undefined,
                timeMs: r.time_ms ?? undefined,
                inputTokens: r.input_tokens ?? undefined,
                outputTokens: r.output_tokens ?? undefined,
                cost: r.cost ?? undefined,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
