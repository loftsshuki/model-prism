"use client";

import { useState, useCallback, useRef } from "react";
import { ModelInfo, ModelResponse, RunState } from "@/lib/types";
import { MODELS } from "@/lib/model-registry";
import { DEFAULT_TEMPLATES } from "@/lib/prompts";
import { fanOut } from "@/lib/fan-out";
import { ModelPicker } from "@/components/model-picker";
import { ResponseCard } from "@/components/response-card";

export default function Home() {
  const [content, setContent] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_TEMPLATES[0].prompt);
  const [selectedTemplate, setSelectedTemplate] = useState(
    DEFAULT_TEMPLATES[0].id
  );
  const [selectedModels, setSelectedModels] = useState<Set<string>>(
    () => new Set(MODELS.filter((m) => m.tier === "frontier").map((m) => m.id))
  );
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("openrouter-api-key") || "";
    }
    return "";
  });
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [responses, setResponses] = useState<Map<string, ModelResponse>>(
    new Map()
  );
  const [status, setStatus] = useState<RunState["status"]>("idle");

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplate(templateId);
    const t = DEFAULT_TEMPLATES.find((t) => t.id === templateId);
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
    const tierModels = MODELS.filter((m) => m.tier === tier);
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

  const handleSelectAll = () => {
    setSelectedModels(new Set(MODELS.map((m) => m.id)));
  };

  const handleClearAll = () => {
    setSelectedModels(new Set());
  };

  const saveApiKey = (key: string) => {
    setApiKey(key);
    if (typeof window !== "undefined") {
      localStorage.setItem("openrouter-api-key", key);
    }
  };

  const handleRun = useCallback(async () => {
    if (!content.trim() || !prompt.trim() || selectedModels.size === 0) return;
    if (!apiKey) {
      setShowKeyInput(true);
      return;
    }

    setStatus("running");
    setResponses(new Map());

    const models = MODELS.filter((m) => selectedModels.has(m.id));

    // Initialize all as pending
    const initial = new Map<string, ModelResponse>();
    models.forEach((m) => {
      initial.set(m.id, {
        model: m.id,
        modelName: m.name,
        status: "pending",
      });
    });
    setResponses(new Map(initial));

    const onUpdate = (modelId: string, response: ModelResponse) => {
      setResponses((prev) => {
        const next = new Map(prev);
        next.set(modelId, response);
        return next;
      });
    };

    await fanOut(models, content, prompt, apiKey, onUpdate);
    setStatus("complete");
  }, [content, prompt, selectedModels, apiKey]);

  const completedCount = [...responses.values()].filter(
    (r) => r.status === "complete" || r.status === "error"
  ).length;
  const totalCount = responses.size;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <span className="text-sm font-bold">P</span>
            </div>
            <h1 className="text-lg font-semibold">Model Prism</h1>
            <span className="text-xs text-neutral-600">
              One input, many angles
            </span>
          </div>
          <button
            onClick={() => setShowKeyInput(!showKeyInput)}
            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            {apiKey ? "Key set" : "Set API Key"}
          </button>
        </div>
      </header>

      {/* API Key Banner */}
      {showKeyInput && (
        <div className="border-b border-neutral-800 bg-neutral-900 px-6 py-3">
          <div className="max-w-7xl mx-auto flex items-center gap-3">
            <label className="text-xs text-neutral-400">
              OpenRouter API Key:
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => saveApiKey(e.target.value)}
              placeholder="sk-or-..."
              className="flex-1 max-w-md bg-neutral-800 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
            />
            <button
              onClick={() => setShowKeyInput(false)}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Main Layout */}
      <div className="max-w-7xl mx-auto flex gap-6 p-6">
        {/* Left Panel — Input */}
        <div className="w-[400px] shrink-0 space-y-4">
          {/* Content Textarea */}
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
              ~{Math.ceil(content.length / 4)} tokens
            </span>
          </div>

          {/* Prompt Template */}
          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-1.5">
              Analysis Prompt
            </label>
            <select
              value={selectedTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500 mb-2"
            >
              {DEFAULT_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500 resize-y"
            />
          </div>

          {/* Model Picker */}
          <ModelPicker
            selected={selectedModels}
            onToggle={handleToggleModel}
            onSelectTier={handleSelectTier}
            onSelectAll={handleSelectAll}
            onClearAll={handleClearAll}
          />

          {/* Run Button */}
          <button
            onClick={handleRun}
            disabled={
              status === "running" ||
              !content.trim() ||
              selectedModels.size === 0
            }
            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 text-sm font-semibold text-white hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {status === "running"
              ? `Running... ${completedCount}/${totalCount}`
              : `Run Analysis (${selectedModels.size} models)`}
          </button>
        </div>

        {/* Right Panel — Results */}
        <div className="flex-1 min-w-0">
          {status === "idle" && responses.size === 0 && (
            <div className="flex items-center justify-center h-64 text-neutral-700">
              <p className="text-center">
                Paste content, pick models, and run.
                <br />
                <span className="text-xs">
                  Responses will appear here in real-time.
                </span>
              </p>
            </div>
          )}

          {responses.size > 0 && (
            <div className="space-y-4">
              {/* Progress */}
              {status === "running" && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-neutral-500">
                    <span>
                      {completedCount} of {totalCount} complete
                    </span>
                    <span>
                      {totalCount > 0
                        ? Math.round((completedCount / totalCount) * 100)
                        : 0}
                      %
                    </span>
                  </div>
                  <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-300"
                      style={{
                        width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Response Cards */}
              <div className="space-y-2">
                {[...responses.values()]
                  .sort((a, b) => {
                    const order = {
                      complete: 0,
                      error: 1,
                      streaming: 2,
                      pending: 3,
                    };
                    return order[a.status] - order[b.status];
                  })
                  .map((response) => (
                    <ResponseCard key={response.model} response={response} />
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
