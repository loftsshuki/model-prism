"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { ModelInfo, ModelResponse, RunState, SynthesisResult } from "@/lib/types";
import { FALLBACK_MODELS, estimateTokens, getModelsFilteredByContext, estimateCost } from "@/lib/model-registry";
import { DEFAULT_TEMPLATES, PromptTemplate } from "@/lib/prompts";
import { fanOut } from "@/lib/fan-out";
import { ModelPicker } from "@/components/model-picker";
import { ResponseCard } from "@/components/response-card";
import { SynthesisView } from "@/components/synthesis-view";
import { CompareView } from "@/components/compare-view";

function generateId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getCustomTemplates(): PromptTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem("custom-templates") || "[]");
  } catch {
    return [];
  }
}

export default function Home() {
  const [content, setContent] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_TEMPLATES[0].prompt);
  const [selectedTemplate, setSelectedTemplate] = useState(DEFAULT_TEMPLATES[0].id);
  const [allModels, setAllModels] = useState<ModelInfo[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(
    () => new Set(FALLBACK_MODELS.filter((m) => m.tier === "frontier").map((m) => m.id))
  );
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("openrouter-api-key") || "";
    return "";
  });
  const [anthropicKey, setAnthropicKey] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("anthropic-api-key") || "";
    return "";
  });
  const [synthesisModel, setSynthesisModel] = useState<"sonnet" | "opus">(() => {
    if (typeof window !== "undefined") return (localStorage.getItem("synthesis-model") as "sonnet" | "opus") || "sonnet";
    return "sonnet";
  });
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [responses, setResponses] = useState<Map<string, ModelResponse>>(new Map());
  const [status, setStatus] = useState<RunState["status"]>("idle");
  const [synthesis, setSynthesis] = useState<SynthesisResult | null>(null);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>([]);

  const allTemplates = useMemo(
    () => [...DEFAULT_TEMPLATES, ...customTemplates],
    [customTemplates]
  );

  // Fetch live models from OpenRouter
  useEffect(() => {
    setCustomTemplates(getCustomTemplates());

    // Check for rerun data from a saved run
    const rerunData = sessionStorage.getItem("rerun");
    if (rerunData) {
      try {
        const { content: rerunContent, prompt: rerunPrompt } = JSON.parse(rerunData);
        if (rerunContent) setContent(rerunContent);
        if (rerunPrompt) setPrompt(rerunPrompt);
      } catch {}
      sessionStorage.removeItem("rerun");
    }

    const key = localStorage.getItem("openrouter-api-key") || "";
    const headers: Record<string, string> = {};
    if (key) headers["x-openrouter-key"] = key;

    fetch("/api/models", { headers })
      .then((r) => r.json())
      .then((data) => {
        if (data.models?.length > 0) {
          setAllModels(data.models);
          // Pre-select frontier models from live list
          const frontierIds = data.models
            .filter((m: ModelInfo) => m.tier === "frontier")
            .slice(0, 8)
            .map((m: ModelInfo) => m.id);
          setSelectedModels(new Set<string>(frontierIds));
        }
        setModelsLoading(false);
      })
      .catch(() => setModelsLoading(false));
  }, []);

  // Token estimation
  const inputTokens = estimateTokens(content + prompt);
  const { tooSmall } = getModelsFilteredByContext(allModels, inputTokens);

  // Cost estimate for selected models
  const selectedModelInfos = allModels.filter((m) => selectedModels.has(m.id));
  const costEstimate = estimateCost(selectedModelInfos, inputTokens);

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplate(templateId);
    const t = allTemplates.find((t) => t.id === templateId);
    if (t) setPrompt(t.prompt);
  };

  const handleToggleModel = (modelId: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const handleSelectTier = (tier: ModelInfo["tier"]) => {
    const tierModels = allModels.filter((m) => m.tier === tier && !tooSmall.has(m.id));
    const allSelected = tierModels.every((m) => selectedModels.has(m.id));
    setSelectedModels((prev) => {
      const next = new Set(prev);
      tierModels.forEach((m) => {
        if (allSelected) next.delete(m.id);
        else next.add(m.id);
      });
      return next;
    });
  };

  const handleSelectPreset = (preset: "frontier" | "diverse" | "all") => {
    const available = allModels.filter((m) => !tooSmall.has(m.id));
    if (preset === "frontier") {
      setSelectedModels(new Set(available.filter((m) => m.tier === "frontier").map((m) => m.id)));
    } else if (preset === "diverse") {
      // One per family per tier
      const seen = new Set<string>();
      const diverse: string[] = [];
      for (const m of available) {
        const key = `${m.family}-${m.tier}`;
        if (!seen.has(key)) {
          seen.add(key);
          diverse.push(m.id);
        }
      }
      setSelectedModels(new Set(diverse));
    } else {
      setSelectedModels(new Set(available.map((m) => m.id)));
    }
  };

  const saveKey = (key: string, type: "openrouter" | "anthropic") => {
    if (type === "openrouter") {
      setApiKey(key);
      localStorage.setItem("openrouter-api-key", key);
    } else {
      setAnthropicKey(key);
      localStorage.setItem("anthropic-api-key", key);
    }
  };

  const toggleCompare = (modelId: string) => {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else if (next.size < 3) next.add(modelId);
      return next;
    });
  };

  const runSynthesis = useCallback(
    async (runId: string, completedResponses: ModelResponse[]) => {
      if (!anthropicKey) {
        setStatus("complete");
        return;
      }

      setStatus("synthesizing");

      const successful = completedResponses.filter((r) => r.status === "complete" && r.response);
      if (successful.length < 2) {
        setStatus("complete");
        return;
      }

      const responsesForSynthesis = successful.map((r) => {
        const model = allModels.find((m) => m.id === r.model);
        return {
          model: r.model,
          modelName: r.modelName,
          family: model?.family ?? "unknown",
          response: r.response!,
        };
      });

      try {
        const res = await fetch("/api/synthesize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            content,
            analysisPrompt: prompt,
            responses: responsesForSynthesis,
            synthesisModel,
            anthropicKey,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          setSynthesis(data.synthesis);
        }
      } catch (error) {
        console.error("Synthesis failed:", error);
      }

      setStatus("complete");
    },
    [anthropicKey, content, prompt, synthesisModel, allModels]
  );

  const handleRun = useCallback(async () => {
    if (!content.trim() || !prompt.trim() || selectedModels.size === 0) return;
    if (!apiKey) {
      setShowKeyInput(true);
      return;
    }

    setStatus("running");
    setResponses(new Map());
    setSynthesis(null);
    setCompareIds(new Set());

    const runId = generateId();
    const models = allModels.filter((m) => selectedModels.has(m.id));

    try {
      await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runId, content, prompt, models: models.map((m) => m.id) }),
      });
    } catch {}

    const initial = new Map<string, ModelResponse>();
    models.forEach((m) => {
      initial.set(m.id, { model: m.id, modelName: m.name, status: "pending" });
    });
    setResponses(new Map(initial));

    const onUpdate = (modelId: string, response: ModelResponse) => {
      setResponses((prev) => {
        const next = new Map(prev);
        next.set(modelId, response);
        return next;
      });
    };

    const results = await fanOut(models, content, prompt, apiKey, runId, onUpdate);
    await runSynthesis(runId, results);
  }, [content, prompt, selectedModels, apiKey, allModels, runSynthesis]);

  const completedCount = [...responses.values()].filter(
    (r) => r.status === "complete" || r.status === "error"
  ).length;
  const totalCount = responses.size;
  const successCount = [...responses.values()].filter((r) => r.status === "complete").length;

  const compareResponses = [...responses.values()].filter((r) => compareIds.has(r.model));

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Compare overlay */}
      {showCompare && compareResponses.length >= 2 && (
        <CompareView responses={compareResponses} onClose={() => setShowCompare(false)} />
      )}

      {/* Header */}
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <span className="text-sm font-bold">P</span>
            </div>
            <h1 className="text-lg font-semibold">Model Prism</h1>
            <span className="text-xs text-neutral-600">One input, many angles</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/history" className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
              History
            </a>
            <a href="/settings" className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
              Settings
            </a>
            <button
              onClick={() => setShowKeyInput(!showKeyInput)}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              {apiKey && anthropicKey ? "Keys set" : "Set Keys"}
            </button>
          </div>
        </div>
      </header>

      {/* API Key Banner */}
      {showKeyInput && (
        <div className="border-b border-neutral-800 bg-neutral-900 px-6 py-3">
          <div className="max-w-7xl mx-auto space-y-2">
            <div className="flex items-center gap-3">
              <label className="text-xs text-neutral-400 w-28">OpenRouter:</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => saveKey(e.target.value, "openrouter")}
                placeholder="sk-or-..."
                className="flex-1 max-w-md bg-neutral-800 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-neutral-400 w-28">Anthropic:</label>
              <input
                type="password"
                value={anthropicKey}
                onChange={(e) => saveKey(e.target.value, "anthropic")}
                placeholder="sk-ant-..."
                className="flex-1 max-w-md bg-neutral-800 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-neutral-400 w-28">Synthesis:</label>
              <div className="flex gap-2">
                <button
                  onClick={() => { setSynthesisModel("sonnet"); localStorage.setItem("synthesis-model", "sonnet"); }}
                  className={`text-xs px-3 py-1 rounded ${synthesisModel === "sonnet" ? "bg-violet-600 text-white" : "bg-neutral-800 text-neutral-400"}`}
                >
                  Sonnet
                </button>
                <button
                  onClick={() => { setSynthesisModel("opus"); localStorage.setItem("synthesis-model", "opus"); }}
                  className={`text-xs px-3 py-1 rounded ${synthesisModel === "opus" ? "bg-violet-600 text-white" : "bg-neutral-800 text-neutral-400"}`}
                >
                  Opus
                </button>
              </div>
            </div>
            <button onClick={() => setShowKeyInput(false)} className="text-xs text-neutral-500 hover:text-neutral-300">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Main Layout */}
      <div className="max-w-7xl mx-auto flex gap-6 p-6">
        {/* Left Panel — Input */}
        <div className="w-[400px] shrink-0 space-y-4">
          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-1.5">
              Content to Analyze
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste a review, copy draft, strategy doc, code..."
              rows={8}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500 resize-y"
            />
            <span className="text-[10px] text-neutral-600">
              ~{inputTokens.toLocaleString()} tokens
            </span>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-1.5">
              Analysis Prompt
            </label>
            <select
              value={selectedTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500 mb-2"
            >
              {allTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500 resize-y"
            />
          </div>

          <ModelPicker
            models={allModels}
            selected={selectedModels}
            tooSmall={tooSmall}
            onToggle={handleToggleModel}
            onSelectTier={handleSelectTier}
            onSelectAll={() => setSelectedModels(new Set(allModels.filter((m) => !tooSmall.has(m.id)).map((m) => m.id)))}
            onClearAll={() => setSelectedModels(new Set())}
            onSelectPreset={handleSelectPreset}
          />

          {/* Cost estimate */}
          {selectedModels.size > 0 && (
            <div className="flex justify-between text-xs text-neutral-500 px-1">
              <span>Est. fan-out cost</span>
              <span>${costEstimate.toFixed(4)}</span>
            </div>
          )}

          <button
            onClick={handleRun}
            disabled={status === "running" || status === "synthesizing" || !content.trim() || selectedModels.size === 0}
            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 text-sm font-semibold text-white hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {status === "running"
              ? `Running... ${completedCount}/${totalCount}`
              : status === "synthesizing"
                ? "Synthesizing..."
                : `Run Analysis (${selectedModels.size} models)`}
          </button>

          {modelsLoading && (
            <p className="text-[10px] text-neutral-600 text-center">Loading live models from OpenRouter...</p>
          )}
        </div>

        {/* Right Panel — Results */}
        <div className="flex-1 min-w-0 space-y-4">
          {status === "idle" && responses.size === 0 && (
            <div className="flex items-center justify-center h-64 text-neutral-700">
              <p className="text-center">
                Paste content, pick models, and run.
                <br />
                <span className="text-xs">Responses will appear here in real-time.</span>
              </p>
            </div>
          )}

          {/* Synthesis */}
          {synthesis && <SynthesisView synthesis={synthesis} />}

          {status === "synthesizing" && (
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-5 text-center">
              <div className="inline-block w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin mr-2" />
              <span className="text-sm text-violet-300">
                Synthesizing with Claude {synthesisModel === "opus" ? "Opus" : "Sonnet"}...
              </span>
            </div>
          )}

          {responses.size > 0 && (
            <div className="space-y-4">
              {/* Progress + compare controls */}
              <div className="flex items-center justify-between">
                {status === "running" ? (
                  <div className="flex-1 space-y-1.5">
                    <div className="flex justify-between text-xs text-neutral-500">
                      <span>{completedCount} of {totalCount} complete</span>
                      <span>{totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0}%</span>
                    </div>
                    <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-300"
                        style={{ width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-neutral-500">
                    {successCount} responses
                  </span>
                )}

                {status === "complete" && compareIds.size >= 2 && (
                  <button
                    onClick={() => setShowCompare(true)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-500 transition-colors"
                  >
                    Compare ({compareIds.size})
                  </button>
                )}
              </div>

              {/* Response Cards */}
              <div className="space-y-2">
                {[...responses.values()]
                  .sort((a, b) => {
                    const order = { complete: 0, error: 1, streaming: 2, pending: 3 };
                    return order[a.status] - order[b.status];
                  })
                  .map((response) => (
                    <ResponseCard
                      key={response.model}
                      response={response}
                      compareMode={status === "complete"}
                      isComparing={compareIds.has(response.model)}
                      onToggleCompare={() => toggleCompare(response.model)}
                    />
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
