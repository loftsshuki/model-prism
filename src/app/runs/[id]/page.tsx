"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SynthesisResult } from "@/lib/types";
import { SynthesisView } from "@/components/synthesis-view";
import { ResponseCard } from "@/components/response-card";

interface SavedRun {
  id: string;
  content: string;
  prompt: string;
  total_cost: number;
  created_at: string;
  models: string[];
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

function exportToMarkdown(run: SavedRun): string {
  const lines: string[] = [];
  lines.push(`# Model Prism Run — ${new Date(run.created_at + "Z").toLocaleString()}`);
  lines.push("");
  lines.push(`## Prompt`);
  lines.push(run.prompt);
  lines.push("");
  lines.push(`## Content`);
  lines.push(run.content);
  lines.push("");

  if (run.synthesis) {
    lines.push(`## Synthesis`);
    lines.push("");

    if (run.synthesis.consensus.length > 0) {
      lines.push(`### Consensus`);
      run.synthesis.consensus.forEach((c) => {
        lines.push(`- **[${c.strength}]** ${c.point} _(${c.supportingModels.length} models)_`);
      });
      lines.push("");
    }

    if (run.synthesis.uniqueInsights.length > 0) {
      lines.push(`### Unique Insights`);
      run.synthesis.uniqueInsights.forEach((u) => {
        lines.push(`- **${u.model}** [${u.significance}]: ${u.insight}`);
      });
      lines.push("");
    }

    if (run.synthesis.disagreements.length > 0) {
      lines.push(`### Disagreements`);
      run.synthesis.disagreements.forEach((d) => {
        lines.push(`**${d.topic}**`);
        d.positions.forEach((p) => {
          lines.push(`  - [${p.models.join(", ")}]: ${p.position}`);
        });
      });
      lines.push("");
    }

    if (run.synthesis.blindSpots.length > 0) {
      lines.push(`### Blind Spots`);
      run.synthesis.blindSpots.forEach((b) => {
        lines.push(`- ${b}`);
      });
      lines.push("");
    }

    if (run.synthesis.themeMatrix && run.synthesis.themeMatrix.length > 0) {
      lines.push(`### Theme Coverage`);
      const models = [...new Set(run.synthesis.themeMatrix.flatMap((t) => Object.keys(t.scores)))];
      lines.push(`| Theme | ${models.join(" | ")} |`);
      lines.push(`| --- | ${models.map(() => "---").join(" | ")} |`);
      run.synthesis.themeMatrix.forEach((t) => {
        const scores = models.map((m) => String(t.scores[m] ?? 0));
        lines.push(`| ${t.theme} | ${scores.join(" | ")} |`);
      });
      lines.push("");
    }
  }

  lines.push(`## Individual Responses`);
  lines.push("");
  run.responses.forEach((r) => {
    lines.push(`### ${r.model_name || r.model}`);
    if (r.time_ms) lines.push(`_${(r.time_ms / 1000).toFixed(1)}s · ${r.output_tokens ?? "?"} tokens_`);
    lines.push("");
    if (r.error) {
      lines.push(`> Error: ${r.error}`);
    } else {
      lines.push(r.response ?? "_(no response)_");
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n");
}

function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
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

  const handleRerun = () => {
    if (!run) return;
    // Store rerun data in sessionStorage so the home page can pick it up
    sessionStorage.setItem(
      "rerun",
      JSON.stringify({
        content: run.content,
        prompt: run.prompt,
      })
    );
    router.push("/");
  };

  const handleExport = () => {
    if (!run) return;
    const md = exportToMarkdown(run);
    const date = new Date(run.created_at + "Z").toISOString().slice(0, 10);
    downloadMarkdown(md, `model-prism-${date}-${run.id.slice(0, 8)}.md`);
  };

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
          <div className="flex items-center gap-3">
            <button
              onClick={handleExport}
              className="text-xs px-3 py-1.5 rounded-lg bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              Export .md
            </button>
            <button
              onClick={handleRerun}
              className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-500 transition-colors"
            >
              Re-run with different models
            </button>
            <a href="/history" className="text-xs text-neutral-500 hover:text-neutral-300">
              History
            </a>
          </div>
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
