"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SynthesisResult } from "@/lib/types";
import { authHeaders } from "@/lib/client-api";
import { buildPlanFrontmatter, getPlanStatus, PLAN_APPROVAL_STATUSES, PlanApprovalStatus, setPlanStatus } from "@/lib/plan-status";
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

function formatDate(raw: string) {
  try {
    const d = new Date(raw.includes("T") ? raw : raw + "Z");
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " at " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<SavedRun | null>(null);
  const [status, setStatus] = useState<PlanApprovalStatus>("council-reviewed");
  const [copiedFrontmatter, setCopiedFrontmatter] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/runs/${id}`, { headers: authHeaders() })
      .then((r) => {
        if (!r.ok) throw new Error("Run not found");
        return r.json();
      })
      .then((data) => {
        setRun(data.run);
        setStatus(getPlanStatus(data.run.id));
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [id]);

  const handleRerun = () => {
    if (!run) return;
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

  const updateStatus = (next: PlanApprovalStatus) => {
    if (!run) return;
    setStatus(next);
    setPlanStatus(run.id, next);
  };

  const copyFrontmatter = async () => {
    if (!run) return;
    const frontmatter = buildPlanFrontmatter({
      status,
      reviewedAt: new Date(run.created_at + "Z").toISOString(),
      approvedAt: ["founder-approved", "ready", "executed"].includes(status) ? new Date().toISOString() : undefined,
      reviewModel: run.synthesisModel,
      roster: run.models,
      criticality: status === "needs-changes" ? "high" : "medium",
    });
    await navigator.clipboard.writeText(frontmatter);
    setCopiedFrontmatter(true);
    window.setTimeout(() => setCopiedFrontmatter(false), 1600);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center text-grey-40">
        Loading...
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center text-grey-40">
        {error || "Run not found"}
      </div>
    );
  }

  const successCount = run.responses.filter((r) => r.response && !r.error).length;

  return (
    <div className="min-h-screen bg-cream text-ink">
      <header className="bg-green text-cream">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
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
          <div className="flex items-center gap-4">
            <button
              onClick={handleExport}
              className="cta-text px-4 py-2 border border-cream/30 text-cream/70 hover:text-cream hover:border-cream/60 transition-colors duration-300"
            >
              Export .md
            </button>
            <button
              onClick={handleRerun}
              className="cta-text px-4 py-2 bg-cream text-green hover:bg-white transition-colors duration-300"
            >
              Re-run
            </button>
            <a href="/history" className="cta-text text-cream/60 hover:text-cream transition-colors duration-300">
              History
            </a>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* Plan Approval */}
        <div className="border border-gold/30 bg-white p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-px bg-gold" />
              <span className="overline text-gold">Plan Approval Workflow</span>
            </div>
            <button onClick={copyFrontmatter} className="cta-text px-3 py-1.5 border border-border text-grey-50 hover:border-gold hover:text-gold transition-colors duration-300">
              {copiedFrontmatter ? "Copied" : "Copy Frontmatter"}
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            {PLAN_APPROVAL_STATUSES.map((item) => (
              <button
                key={item.id}
                onClick={() => updateStatus(item.id)}
                className={`text-left border px-3 py-2 transition-colors ${status === item.id ? "border-gold bg-gold/10" : "border-border hover:border-gold/50"}`}
              >
                <span className="block text-xs font-medium text-grey-60">{item.label}</span>
                <span className="block text-[9px] text-grey-30 mt-1 leading-snug">{item.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Run Info */}
        <div className="border border-border bg-white p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-px bg-green" />
            <span className="overline text-green">Run Details</span>
          </div>
          <p className="text-sm text-ink font-medium mb-2">{run.prompt}</p>
          <p className="text-xs text-grey-40 line-clamp-3 leading-relaxed">{run.content}</p>
          <div className="flex gap-4 mt-4 pt-3 border-t border-border">
            <span className="text-[10px] tracking-wide uppercase text-grey-40">{successCount} of {run.responses.length} models</span>
            <span className="text-[10px] tracking-wide text-grey-30">{formatDate(run.created_at)}</span>
            {run.total_cost > 0 && (
              <span className="text-[10px] tracking-wide text-grey-30">${run.total_cost.toFixed(4)}</span>
            )}
            {run.synthesisModel && (
              <span className="text-[10px] tracking-wide uppercase text-gold">Synthesized with {run.synthesisModel}</span>
            )}
          </div>
        </div>

        {/* Synthesis */}
        {run.synthesis && <SynthesisView synthesis={run.synthesis} />}

        {/* Responses */}
        <div className="space-y-2">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-px bg-grey-20" />
            <span className="overline text-grey-40">Individual Responses</span>
          </div>
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
