"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ModelInfo, ModelResponse, RunState, SynthesisResult, ContextPack } from "@/lib/types";
import { FALLBACK_MODELS, estimateTokens, getModelsFilteredByContext, estimateCost } from "@/lib/model-registry";
import { DEFAULT_TEMPLATES, PromptTemplate } from "@/lib/prompts";
import { DEFAULT_RUN_PRESETS, ModelSelectionPreset, selectModelsForPreset } from "@/lib/run-presets";
import { getActiveProjectProfileId, getProjectProfiles, ProjectProfile, setActiveProjectProfileId } from "@/lib/project-profiles";
import { fanOut } from "@/lib/fan-out";
import { SYNTHESIS_MODEL_IDS, synthesizeDirect } from "@/lib/synthesis";
import { getContextPacks, getActivePackId, buildContextString } from "@/lib/context-packs";
import { jsonHeaders } from "@/lib/client-api";
import { parseDiffFiles, summarizeDiffFiles } from "@/lib/pr-review";
import { getCachedFileContent } from "@/lib/context-cache";
import { ModelPicker } from "@/components/model-picker";
import { ResponseCard } from "@/components/response-card";
import { SynthesisView } from "@/components/synthesis-view";
import { CompareView } from "@/components/compare-view";
import { ContextPanel } from "@/components/context-panel";
import { SynthesisComparisonView } from "@/components/synthesis-comparison";

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
    if (typeof window !== "undefined") return (localStorage.getItem("synthesis-model") as "sonnet" | "opus") || "opus";
    return "opus";
  });
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [responses, setResponses] = useState<Map<string, ModelResponse>>(new Map());
  const [status, setStatus] = useState<RunState["status"]>("idle");
  const [synthesis, setSynthesis] = useState<SynthesisResult | null>(null);
  const [secondPassSynthesis, setSecondPassSynthesis] = useState<SynthesisResult | null>(null);
  const [secondPassLoading, setSecondPassLoading] = useState(false);
  const [secondPassError, setSecondPassError] = useState<string | null>(null);
  const [synthesisError, setSynthesisError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);
  const [copied, setCopied] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>([]);
  const [projectProfiles, setProjectProfiles] = useState<ProjectProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [selectedRunPresetId, setSelectedRunPresetId] = useState(DEFAULT_RUN_PRESETS[0].id);
  const [maxRunCost, setMaxRunCost] = useState(() => {
    if (typeof window !== "undefined") return Number(localStorage.getItem("model-prism-max-run-cost") || "1.5");
    return 1.5;
  });
  const [prUrl, setPrUrl] = useState("");
  const [prLoading, setPrLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [prSummary, setPrSummary] = useState<{ fileCount: number; additions: number; deletions: number; riskyFiles: Array<{ path: string }> } | null>(null);
  const appliedInitialProfileRef = useRef(false);

  // --- Context Pack state ---
  const [githubPat, setGithubPat] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("github-pat") || "";
    return "";
  });
  const [activePack, setActivePack] = useState<ContextPack | null>(null);
  const [contextEnabled, setContextEnabled] = useState(false);
  const [contextFileContents, setContextFileContents] = useState<Record<string, string>>({});
  const [contextTokens, setContextTokens] = useState(0);

  const allTemplates = useMemo(() => [
    ...DEFAULT_RUN_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, prompt: preset.prompt })),
    ...DEFAULT_TEMPLATES,
    ...customTemplates,
  ], [customTemplates]);

  // Load active context pack on mount
  useEffect(() => {
    const activeId = getActivePackId();
    if (activeId) {
      const packs = getContextPacks();
      const pack = packs.find((p) => p.id === activeId);
      if (pack) {
        setActivePack(pack);
        setContextEnabled(true);
        // Load cached file contents
        (async () => {
          const contents: Record<string, string> = {};
          for (const path of pack.selectedFiles) {
            const cached = await getCachedFileContent(pack.repo, pack.branch, path);
            if (cached) contents[path] = cached.content;
          }
          setContextFileContents(contents);
        })();
      }
    }
  }, []);

  useEffect(() => {
    setCustomTemplates(getCustomTemplates());
    const profiles = getProjectProfiles();
    const activeProfile = getActiveProjectProfileId();
    setProjectProfiles(profiles);
    setActiveProfileId(activeProfile);
    const profile = profiles.find((p) => p.id === activeProfile);
    if (profile) {
      setSelectedRunPresetId(profile.defaultRunPresetId);
      setSynthesisModel(profile.defaultSynthesisModel);
      setMaxRunCost(profile.defaultMaxCost);
      localStorage.setItem("synthesis-model", profile.defaultSynthesisModel);
      localStorage.setItem("model-prism-max-run-cost", String(profile.defaultMaxCost));
    }
    const storedPreset = localStorage.getItem("model-prism-run-preset");
    if (storedPreset) setSelectedRunPresetId(storedPreset);
    const rerunData = sessionStorage.getItem("rerun");
    if (rerunData) {
      try {
        const { content: rc, prompt: rp } = JSON.parse(rerunData);
        if (rc) setContent(rc);
        if (rp) setPrompt(rp);
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

  // Re-read GitHub PAT from localStorage (settings page might update it)
  useEffect(() => {
    const handleStorage = () => {
      setGithubPat(localStorage.getItem("github-pat") || "");
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Token estimation includes context
  const baseInputTokens = estimateTokens(content + prompt);
  const inputTokens = baseInputTokens + contextTokens;
  const { tooSmall } = getModelsFilteredByContext(allModels, inputTokens);
  const selectedModelInfos = allModels.filter((m) => selectedModels.has(m.id));
  const costEstimate = estimateCost(selectedModelInfos, inputTokens);

  const applyModelSelectionPreset = useCallback((preset: ModelSelectionPreset) => {
    setSelectedModels(selectModelsForPreset(allModels, preset, tooSmall));
  }, [allModels, tooSmall]);

  const applyRunPreset = useCallback((presetId: string) => {
    const preset = DEFAULT_RUN_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;

    setSelectedRunPresetId(preset.id);
    localStorage.setItem("model-prism-run-preset", preset.id);
    setSelectedTemplate(preset.id);
    setPrompt(preset.prompt);
    setSynthesisModel(preset.synthesisModel);
    localStorage.setItem("synthesis-model", preset.synthesisModel);
    setMaxRunCost(preset.maxCost);
    localStorage.setItem("model-prism-max-run-cost", String(preset.maxCost));
    applyModelSelectionPreset(preset.modelPreset);
  }, [applyModelSelectionPreset]);

  const applyProjectProfile = useCallback((profileId: string) => {
    const profile = projectProfiles.find((item) => item.id === profileId);
    if (!profile) return;

    setActiveProfileId(profile.id);
    setActiveProjectProfileId(profile.id);
    applyRunPreset(profile.defaultRunPresetId);
    setSynthesisModel(profile.defaultSynthesisModel);
    localStorage.setItem("synthesis-model", profile.defaultSynthesisModel);
    setMaxRunCost(profile.defaultMaxCost);
    localStorage.setItem("model-prism-max-run-cost", String(profile.defaultMaxCost));
    applyModelSelectionPreset(profile.defaultModelPreset);

    if (profile.defaultContextPackName) {
      const pack = getContextPacks().find((item) => item.name.toLowerCase().includes(profile.defaultContextPackName!.toLowerCase()));
      if (pack) {
        setActivePack(pack);
        setContextEnabled(true);
      }
    }
  }, [applyModelSelectionPreset, applyRunPreset, projectProfiles]);

  useEffect(() => {
    if (modelsLoading || !projectProfiles.length || appliedInitialProfileRef.current) return;
    appliedInitialProfileRef.current = true;
    applyProjectProfile(activeProfileId || getActiveProjectProfileId());
  }, [activeProfileId, applyProjectProfile, modelsLoading, projectProfiles.length]);

  const handleTemplateChange = (templateId: string) => {
    const runPreset = DEFAULT_RUN_PRESETS.find((preset) => preset.id === templateId);
    if (runPreset) {
      applyRunPreset(runPreset.id);
      return;
    }

    setSelectedTemplate(templateId);
    const t = allTemplates.find((item) => item.id === templateId);
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
      tierModels.forEach((m) => { if (allSelected) next.delete(m.id); else next.add(m.id); });
      return next;
    });
  };

  const handleSelectPreset = (preset: "frontier" | "diverse" | "all" | "free") => {
    const available = allModels.filter((m) => !tooSmall.has(m.id));
    if (preset === "free") {
      setSelectedModels(new Set(available.filter((m) => m.tier === "free").map((m) => m.id)));
    } else if (preset === "frontier") {
      setSelectedModels(new Set(available.filter((m) => m.tier === "frontier").map((m) => m.id)));
    } else if (preset === "diverse") {
      const seen = new Set<string>();
      const diverse: string[] = [];
      for (const m of available) {
        const key = `${m.family}-${m.tier}`;
        if (!seen.has(key)) { seen.add(key); diverse.push(m.id); }
      }
      setSelectedModels(new Set(diverse));
    } else {
      setSelectedModels(new Set(available.map((m) => m.id)));
    }
  };

  const saveKey = (key: string, type: "openrouter" | "anthropic") => {
    if (type === "openrouter") { setApiKey(key); localStorage.setItem("openrouter-api-key", key); }
    else { setAnthropicKey(key); localStorage.setItem("anthropic-api-key", key); }
  };

  const loadPullRequest = useCallback(async () => {
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    if (!match) {
      setPrError("Paste a GitHub PR URL like https://github.com/owner/repo/pull/123");
      return;
    }
    const [, owner, repo, pullNumber] = match;
    setPrLoading(true);
    setPrError(null);
    try {
      const headers: Record<string, string> = { Accept: "application/vnd.github.v3.diff" };
      if (githubPat) headers.Authorization = `Bearer ${githubPat}`;
      const diffRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, { headers });
      if (!diffRes.ok) throw new Error(`GitHub returned ${diffRes.status}. Check token access or PR URL.`);
      const diff = await diffRes.text();
      const files = parseDiffFiles(diff);
      setPrSummary(summarizeDiffFiles(files));
      const metaHeaders: Record<string, string> = { Accept: "application/vnd.github+json" };
      if (githubPat) metaHeaders.Authorization = `Bearer ${githubPat}`;
      const meta = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, { headers: metaHeaders }).then((r) => r.ok ? r.json() : null).catch(() => null);
      setContent(`# Pull Request Review\n\nRepo: ${owner}/${repo}\nPR: #${pullNumber}${meta?.title ? ` — ${meta.title}` : ""}\nURL: ${prUrl}\n\n## Diff\n\n\`\`\`diff\n${diff.slice(0, 120000)}\n\`\`\``);
      applyRunPreset("code-review");
      setPrUrl("");
    } catch (error) {
      setPrError(error instanceof Error ? error.message : "Could not load PR diff");
    } finally {
      setPrLoading(false);
    }
  }, [applyRunPreset, githubPat, prUrl]);

  const toggleCompare = (modelId: string) => {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  // Build context string for current run
  const getContextString = useCallback((): string | undefined => {
    if (!activePack || !contextEnabled) return undefined;
    const cs = buildContextString(activePack, contextFileContents);
    return cs || undefined;
  }, [activePack, contextEnabled, contextFileContents]);

  const runSynthesis = useCallback(
    async (runId: string, completedResponses: ModelResponse[], durationSec = 0) => {
      if (!anthropicKey) { setStatus("complete"); return; }
      setStatus("synthesizing");
      setSynthesisError(null);
      setSecondPassSynthesis(null);
      setSecondPassError(null);
      const successful = completedResponses.filter((r) => r.status === "complete" && r.response);
      if (successful.length < 2) { setStatus("complete"); return; }
      const responsesForSynthesis = successful.map((r) => {
        const model = allModels.find((m) => m.id === r.model);
        return { model: r.model, modelName: r.modelName, family: model?.family ?? "unknown", response: r.response! };
      });
      try {
        const contextString = getContextString();
        const result = await synthesizeDirect(anthropicKey, synthesisModel, content, prompt, responsesForSynthesis, contextString);
        setSynthesis(result);
        // Save to DB and telemetry ledger in background
        const modelId = SYNTHESIS_MODEL_IDS[synthesisModel];
        if (runId) {
          fetch("/api/synthesize/save", {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ runId, result: JSON.stringify(result), modelUsed: modelId }),
          }).catch(() => {});
        }
        const usedModelIds = new Set(completedResponses.map((response) => response.model));
        fetch("/api/telemetry", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            content,
            contextRepo: activePack?.repo || "none",
            durationSec,
            plan: selectedRunPresetId,
            responses: completedResponses,
            roster: selectedRunPresetId,
            synthesis: result,
            synthesisModel: modelId,
            usedModels: allModels.filter((model) => usedModelIds.has(model.id)),
          }),
        }).catch(() => {});
      } catch (error) {
        console.error("Synthesis failed:", error);
        setSynthesisError(error instanceof Error ? error.message : "Synthesis failed");
      }
      setStatus("complete");
    },
    [activePack?.repo, anthropicKey, content, prompt, selectedRunPresetId, synthesisModel, allModels, getContextString]
  );

  const runSecondPass = useCallback(async () => {
    if (!anthropicKey || !synthesis) {
      if (!anthropicKey) setShowKeyInput(true);
      return;
    }

    const successful = [...responses.values()].filter((r) => r.status === "complete" && r.response);
    if (successful.length < 2) {
      setSecondPassError("Second pass needs at least two completed model responses.");
      return;
    }

    const responsesForSynthesis = successful.map((r) => {
      const model = allModels.find((m) => m.id === r.model);
      return { model: r.model, modelName: r.modelName, family: model?.family ?? "unknown", response: r.response! };
    });

    setSecondPassLoading(true);
    setSecondPassError(null);
    try {
      const contextString = getContextString();
      const secondPassInstructions = `Critique the existing synthesis instead of simply producing another normal synthesis.

Focus on:
- assumptions the synthesis made without enough evidence
- risks, blockers, or edge cases it missed
- weak or vague recommendations that need to become concrete
- contradictions between model responses that the synthesis smoothed over
- missing tests, security checks, or rollout safeguards

Produce a revised masterDocument that starts with a direct verdict: APPROVE, APPROVE WITH CHANGES, or REVISE. Then list must-fix items, should-fix items, and remaining open questions. Keep the structured fields populated as usual.`;
      const result = await synthesizeDirect(
        anthropicKey,
        synthesisModel,
        `Original content:\n${content}\n\nExisting synthesis to critique:\n${synthesis.masterDocument || ""}`,
        prompt,
        responsesForSynthesis,
        contextString,
        secondPassInstructions
      );
      setSecondPassSynthesis(result);
    } catch (error) {
      console.error("Second-pass synthesis failed:", error);
      setSecondPassError(error instanceof Error ? error.message : "Second-pass synthesis failed");
    } finally {
      setSecondPassLoading(false);
    }
  }, [allModels, anthropicKey, content, getContextString, prompt, responses, synthesis, synthesisModel]);

  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [aborted, setAborted] = useState(false);
  const abortRef = useRef(false);

  const handleRun = useCallback(async () => {
    if (!content.trim() || !prompt.trim() || selectedModels.size === 0) return;
    if (!apiKey) { setShowKeyInput(true); return; }

    // Determine which models still need to run
    const alreadyRan = new Set([...responses.keys()].filter((id) => {
      const r = responses.get(id);
      return r && r.status === "complete";
    }));
    const modelsToRun = allModels.filter((m) => selectedModels.has(m.id) && !alreadyRan.has(m.id));

    if (modelsToRun.length === 0) return;

    const estimatedRunCost = estimateCost(modelsToRun, inputTokens);
    if (maxRunCost > 0 && estimatedRunCost > maxRunCost) {
      const proceed = window.confirm(`Estimated cost is $${estimatedRunCost.toFixed(4)}, above your $${maxRunCost.toFixed(2)} run budget. Continue anyway?`);
      if (!proceed) return;
    }

    const isAppending = responses.size > 0 && alreadyRan.size > 0;
    const runId = isAppending && currentRunId ? currentRunId : generateId();

    const runStartedAt = Date.now();
    setStatus("running");
    setSynthesis(null);
    setSecondPassSynthesis(null);
    setSynthesisError(null);
    setSecondPassError(null);
    setRunStartTime(runStartedAt);
    setElapsed(0);

    if (!isAppending) {
      setResponses(new Map());
      setCompareIds(new Set());
      setCurrentRunId(runId);

      // Build context metadata for run persistence
      const contextMeta = activePack && contextEnabled
        ? JSON.stringify({
          packName: activePack.name,
          repo: activePack.repo,
          branch: activePack.branch,
          briefIncluded: !!activePack.brief,
          files: activePack.selectedFiles,
          totalContextTokens: contextTokens,
        })
        : null;

      try {
        await fetch("/api/runs", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            id: runId, content, prompt,
            models: modelsToRun.map((m) => m.id),
            contextMetadata: contextMeta,
          }),
        });
      } catch {}
    }

    // Add pending cards for new models (keep existing responses)
    setResponses((prev) => {
      const next = new Map(prev);
      modelsToRun.forEach((m) => { next.set(m.id, { model: m.id, modelName: m.name, status: "pending" }); });
      return next;
    });

    const onUpdate = (modelId: string, response: ModelResponse) => {
      setResponses((prev) => { const next = new Map(prev); next.set(modelId, response); return next; });
    };

    abortRef.current = false;
    setAborted(false);

    const contextString = getContextString();
    const newResults = await fanOut({
      models: modelsToRun,
      content,
      prompt,
      apiKey,
      runId,
      maxTokens: 4096,
      isAborted: () => abortRef.current,
      onUpdate,
      context: contextString,
    });

    // Combine with existing successful responses for synthesis
    const allCompleted = [
      ...[...responses.values()].filter((r) => r.status === "complete" && !modelsToRun.find((m) => m.id === r.model)),
      ...newResults,
    ];
    await runSynthesis(runId, allCompleted, Math.floor((Date.now() - runStartedAt) / 1000));
  }, [content, prompt, selectedModels, apiKey, allModels, runSynthesis, responses, currentRunId, getContextString, activePack, contextEnabled, contextTokens, inputTokens, maxRunCost]);

  const handleStop = useCallback(() => {
    abortRef.current = true;
    setAborted(true);
    setStatus("complete");
  }, []);

  const handleRetryFailed = useCallback(async () => {
    if (!apiKey) return;
    const failedModels = allModels.filter((m) => {
      const r = responses.get(m.id);
      return r && r.status === "error" && !r.error?.includes("404") && !r.error?.includes("unavailable");
    });
    if (failedModels.length === 0) return;

    const runId = currentRunId || generateId();
    const runStartedAt = Date.now();
    setStatus("running");
    setRunStartTime(runStartedAt);
    setElapsed(0);
    abortRef.current = false;
    setAborted(false);

    // Reset failed models to pending
    setResponses((prev) => {
      const next = new Map(prev);
      failedModels.forEach((m) => { next.set(m.id, { model: m.id, modelName: m.name, status: "pending" }); });
      return next;
    });

    const onUpdate = (modelId: string, response: ModelResponse) => {
      setResponses((prev) => { const next = new Map(prev); next.set(modelId, response); return next; });
    };

    const contextString = getContextString();
    const newResults = await fanOut({
      models: failedModels,
      content,
      prompt,
      apiKey,
      runId,
      maxTokens: 4096,
      isAborted: () => abortRef.current,
      onUpdate,
      context: contextString,
    });

    const allCompleted = [
      ...[...responses.values()].filter((r) => r.status === "complete" && !failedModels.find((m) => m.id === r.model)),
      ...newResults,
    ];
    await runSynthesis(runId, allCompleted, Math.floor((Date.now() - runStartedAt) / 1000));
  }, [apiKey, allModels, responses, currentRunId, content, prompt, runSynthesis, getContextString]);

  const completedCount = [...responses.values()].filter((r) => r.status === "complete" || r.status === "error").length;
  const totalCount = responses.size;
  const successCount = [...responses.values()].filter((r) => r.status === "complete").length;
  const compareResponses = [...responses.values()].filter((r) => compareIds.has(r.model));

  // How many selected models haven't been run yet
  const alreadyCompleted = new Set([...responses.keys()].filter((id) => responses.get(id)?.status === "complete"));
  const retryableCount = [...responses.values()].filter((r) => r.status === "error" && !r.error?.includes("404") && !r.error?.includes("unavailable")).length;
  const newModelsCount = [...selectedModels].filter((id) => !alreadyCompleted.has(id)).length;

  // Timer
  const [runStartTime, setRunStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status === "running" || status === "synthesizing") {
      if (!runStartTime) setRunStartTime(Date.now());
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - (runStartTime || Date.now())) / 1000));
      }, 1000);
      return () => clearInterval(interval);
    } else {
      if (runStartTime) {
        setElapsed(Math.floor((Date.now() - runStartTime) / 1000));
        setRunStartTime(null);
      }
    }
  }, [status, runStartTime]);

  function formatElapsed(s: number): string {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  return (
    <div className="min-h-screen flex flex-col">
      {showCompare && compareResponses.length >= 2 && (
        <CompareView responses={compareResponses} onClose={() => setShowCompare(false)} />
      )}

      {/* Hero Header */}
      <header className="bg-green text-cream">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-12 py-5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-9 h-9 rounded-none border border-cream/30 flex items-center justify-center">
              <span className="font-display text-lg font-bold tracking-tight">P</span>
            </div>
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight leading-none">Model Prism</h1>
              <p className="text-[10px] tracking-[0.2em] uppercase text-cream/50 mt-0.5">One Input, Many Angles</p>
            </div>
          </div>
          <nav className="flex items-center gap-6">
            <a href="/history" className="cta-text text-cream/60 hover:text-cream transition-colors duration-300">History</a>
            <a href="/models" className="cta-text text-cream/60 hover:text-cream transition-colors duration-300">Models</a>
            <a href="/hooks" className="cta-text text-cream/60 hover:text-cream transition-colors duration-300">Hooks</a>
            <a href="/settings" className="cta-text text-cream/60 hover:text-cream transition-colors duration-300">Settings</a>
            <button
              onClick={() => setShowKeyInput(!showKeyInput)}
              className="cta-text text-cream/60 hover:text-cream transition-colors duration-300"
            >
              {apiKey && anthropicKey ? "Keys Set" : "Set Keys"}
            </button>
          </nav>
        </div>
      </header>

      {/* API Key Drawer */}
      {showKeyInput && (
        <div className="bg-grey-70 text-cream px-6 lg:px-12 py-4">
          <div className="max-w-[1400px] mx-auto space-y-3">
            <div className="flex items-center gap-4">
              <label className="overline text-grey-30 w-32 shrink-0">OpenRouter</label>
              <input type="password" value={apiKey} onChange={(e) => saveKey(e.target.value, "openrouter")} placeholder="sk-or-..."
                className="flex-1 max-w-lg bg-grey-60 border border-grey-50 px-4 py-2 text-sm text-cream placeholder:text-grey-40 focus:outline-none focus:border-gold" />
            </div>
            <div className="flex items-center gap-4">
              <label className="overline text-grey-30 w-32 shrink-0">Anthropic</label>
              <input type="password" value={anthropicKey} onChange={(e) => saveKey(e.target.value, "anthropic")} placeholder="sk-ant-..."
                className="flex-1 max-w-lg bg-grey-60 border border-grey-50 px-4 py-2 text-sm text-cream placeholder:text-grey-40 focus:outline-none focus:border-gold" />
            </div>
            <div className="flex items-center gap-4">
              <label className="overline text-grey-30 w-32 shrink-0">Synthesis</label>
              <div className="flex gap-2">
                {(["sonnet", "opus"] as const).map((m) => (
                  <button key={m} onClick={() => { setSynthesisModel(m); localStorage.setItem("synthesis-model", m); }}
                    className={`cta-text px-4 py-2 transition-colors duration-300 ${synthesisModel === m ? "bg-green text-cream" : "bg-grey-60 text-grey-30 hover:text-cream"}`}>
                    {m === "sonnet" ? "Sonnet" : "Opus"}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={() => setShowKeyInput(false)} className="cta-text text-grey-30 hover:text-cream transition-colors duration-300">Close</button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex">
        {/* Left Sidebar — Input */}
        <aside className="w-1/2 shrink-0 border-r border-border bg-white overflow-y-auto">
          <div className="p-6 lg:p-8 space-y-6">
            {/* Section: Project + Run Preset */}
            <div className="border border-border bg-cream/40 p-4 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-px bg-green" />
                <span className="overline text-green">Project + Run Setup</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-grey-40">Project profile</span>
                  <select
                    value={activeProfileId}
                    onChange={(e) => applyProjectProfile(e.target.value)}
                    className="mt-1 w-full bg-white border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:border-green"
                  >
                    {projectProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-grey-40">Run preset</span>
                  <select
                    value={selectedRunPresetId}
                    onChange={(e) => applyRunPreset(e.target.value)}
                    className="mt-1 w-full bg-white border border-border px-3 py-2 text-sm text-ink focus:outline-none focus:border-green"
                  >
                    {DEFAULT_RUN_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 items-end">
                <p className="text-xs text-grey-40 leading-relaxed">
                  {DEFAULT_RUN_PRESETS.find((preset) => preset.id === selectedRunPresetId)?.description || "Choose a preset to configure prompt, model mix, synthesis model, and budget."}
                </p>
                <label className="block min-w-[150px]">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-grey-40">Max run cost</span>
                  <div className="mt-1 flex items-center gap-1 bg-white border border-border px-3 py-2">
                    <span className="text-sm text-grey-40">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.25"
                      value={maxRunCost}
                      onChange={(e) => {
                        const value = Number(e.target.value || "0");
                        setMaxRunCost(value);
                        localStorage.setItem("model-prism-max-run-cost", String(value));
                      }}
                      className="w-full bg-transparent text-sm text-ink focus:outline-none"
                    />
                  </div>
                </label>
              </div>
            </div>

            {/* Section: PR Review */}
            <div className="border border-border bg-white p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-px bg-green" />
                <span className="overline text-green">GitHub PR Review</span>
              </div>
              <div className="flex gap-2">
                <input
                  value={prUrl}
                  onChange={(e) => setPrUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/pull/123"
                  className="flex-1 bg-grey-5 border border-border px-3 py-2 text-xs text-ink placeholder:text-grey-30 focus:outline-none focus:border-green"
                />
                <button
                  onClick={loadPullRequest}
                  disabled={prLoading || !prUrl.trim()}
                  className="cta-text px-4 py-2 border border-green text-green hover:bg-green-light disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-300"
                >
                  {prLoading ? "Loading" : "Load Diff"}
                </button>
              </div>
              {prError && <p className="text-[10px] text-red-600">{prError}</p>}
              {prSummary && (
                <div className="text-[10px] text-grey-40 bg-grey-5 border border-border px-3 py-2 leading-relaxed">
                  Loaded {prSummary.fileCount} files (+{prSummary.additions}/-{prSummary.deletions})
                  {prSummary.riskyFiles.length > 0 && (
                    <span className="text-gold"> · Risk-sensitive: {prSummary.riskyFiles.slice(0, 3).map((file) => file.path).join(", ")}</span>
                  )}
                </div>
              )}
              <p className="text-[10px] text-grey-30 leading-relaxed">
                Loads the PR diff into Content and switches to the Code Review preset. Private repos need a GitHub token in Settings.
              </p>
            </div>

            {/* Section: Content */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-px bg-green" />
                <span className="overline text-green">Content</span>
              </div>
              <textarea value={content} onChange={(e) => setContent(e.target.value)}
                placeholder="Paste a review, copy draft, strategy doc, code..."
                rows={10}
                className="w-full bg-grey-5 border border-border px-4 py-3 text-sm text-ink placeholder:text-grey-30 focus:outline-none focus:border-green resize-y leading-relaxed" />
              <p className="text-[10px] text-grey-30 mt-1.5 tracking-wide">
                ~{baseInputTokens.toLocaleString()} tokens
                {contextTokens > 0 && contextEnabled && (
                  <span className="text-gold"> + {contextTokens.toLocaleString()} context</span>
                )}
              </p>
            </div>

            {/* Section: Codebase Context */}
            <ContextPanel
              githubPat={githubPat}
              anthropicKey={anthropicKey}
              activePack={activePack}
              contextEnabled={contextEnabled}
              contentText={content}
              fileContents={contextFileContents}
              onPackChange={setActivePack}
              onContextEnabledChange={setContextEnabled}
              onFileContentsChange={setContextFileContents}
              onContextTokensChange={setContextTokens}
            />

            {/* Section: Prompt */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-px bg-green" />
                <span className="overline text-green">Analysis Prompt</span>
              </div>
              <select value={selectedTemplate} onChange={(e) => handleTemplateChange(e.target.value)}
                className="w-full bg-grey-5 border border-border px-4 py-2.5 text-sm text-ink focus:outline-none focus:border-green mb-3 appearance-none cursor-pointer">
                {allTemplates.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
              </select>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
                className="w-full bg-grey-5 border border-border px-4 py-3 text-sm text-ink placeholder:text-grey-30 focus:outline-none focus:border-green resize-y leading-relaxed" />
            </div>

            {/* Section: Models */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-px bg-green" />
                <span className="overline text-green">Models</span>
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
              {selectedModels.size > 0 && (
                <div className="space-y-1 mt-3">
                  <div className="flex justify-between text-[10px] text-grey-40 tracking-wide">
                    <span>Estimated cost</span>
                    <span className={`font-medium ${maxRunCost > 0 && costEstimate > maxRunCost ? "text-red-600" : "text-gold"}`}>
                      ${costEstimate.toFixed(4)} / ${maxRunCost.toFixed(2)} max
                    </span>
                  </div>
                  {contextTokens > 0 && contextEnabled && (
                    <div className="flex justify-between text-[10px] text-grey-30 tracking-wide">
                      <span>Context adds</span>
                      <span className="text-gold">
                        ~{contextTokens.toLocaleString()} tokens x {selectedModels.size} models
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Context active indicator near run button */}
            {activePack && contextEnabled && (
              <div className="flex items-center gap-2 text-[10px] text-green bg-green-light px-3 py-2">
                <span>●</span>
                <span>Context: {activePack.name} ({contextTokens.toLocaleString()} tokens)</span>
              </div>
            )}

            {/* Run Button */}
            {status === "running" ? (
              <div className="flex gap-2">
                <div className="flex-1 py-3.5 bg-green/80 text-cream cta-text tracking-[0.15em] text-center">
                  Analyzing... {completedCount}/{totalCount} &middot; {formatElapsed(elapsed)}
                </div>
                <button onClick={handleStop}
                  className="px-6 py-3.5 bg-grey-60 text-cream cta-text tracking-[0.15em] hover:bg-ink transition-colors duration-300 active:scale-[0.98]">
                  Stop
                </button>
              </div>
            ) : (
              <button onClick={handleRun}
                disabled={status === "synthesizing" || !content.trim() || newModelsCount === 0}
                className="w-full py-3.5 bg-green text-cream cta-text tracking-[0.15em] hover:bg-green-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-300 active:scale-[0.98]">
                {status === "synthesizing"
                  ? `Synthesizing... \u00B7 ${formatElapsed(elapsed)}`
                  : alreadyCompleted.size > 0 && newModelsCount > 0
                    ? `Add ${newModelsCount} More Models`
                    : alreadyCompleted.size > 0 && newModelsCount === 0
                      ? "All Selected Models Complete"
                      : `Run Analysis \u00B7 ${selectedModels.size} Models`}
              </button>
            )}

            {modelsLoading && (
              <p className="text-[10px] text-grey-30 text-center tracking-wide">Loading models from OpenRouter...</p>
            )}
          </div>
        </aside>

        {/* Main Results Area */}
        <main className="flex-1 min-w-0 overflow-y-auto bg-cream">
          <div className="max-w-[900px] mx-auto px-6 lg:px-12 py-8 lg:py-12">
            {/* Empty State */}
            {status === "idle" && responses.size === 0 && (
              <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                <div className="w-12 h-px bg-grey-20 mb-6" />
                <h2 className="font-display text-3xl font-bold text-grey-60 mb-3">Begin Your Analysis</h2>
                <p className="text-sm text-grey-30 max-w-md leading-relaxed">
                  Paste content into the left panel, select your models, and run.
                  Responses appear here in real-time as each model completes.
                </p>
                <div className="w-12 h-px bg-grey-20 mt-6" />
              </div>
            )}

            {/* Synthesis */}
            {synthesis && (
              <div className="mb-8 space-y-8">
                <SynthesisView
                  synthesis={synthesis}
                  onSecondPass={runSecondPass}
                  secondPassLoading={secondPassLoading}
                />
                {secondPassError && (
                  <div className="border border-red-200 bg-red-50 text-red-700 text-sm p-4">
                    {secondPassError}
                  </div>
                )}
                {secondPassSynthesis && (
                  <>
                    <SynthesisComparisonView previous={synthesis} next={secondPassSynthesis} />
                    <SynthesisView
                      synthesis={secondPassSynthesis}
                      title="Second-Pass Review"
                      eyebrow="Synthesis critique"
                    />
                  </>
                )}
              </div>
            )}

            {/* Synthesizing Indicator */}
            {status === "synthesizing" && (
              <div className="border border-green/20 bg-green-light p-6 mb-8 text-center">
                <div className="inline-block w-4 h-4 border-2 border-green border-t-transparent rounded-full animate-spin mr-3 align-middle" />
                <span className="text-sm text-green font-medium">
                  Synthesizing with Claude {synthesisModel === "opus" ? "Opus" : "Sonnet"}...
                </span>
              </div>
            )}

            {responses.size > 0 && (
              <div className="space-y-6">
                {/* Progress + Compare */}
                <div className="flex items-center justify-between">
                  {status === "running" ? (
                    <div className="flex-1 space-y-2">
                      <div className="flex justify-between text-[10px] tracking-wide text-grey-40">
                        <span>{completedCount} of {totalCount} complete</span>
                        <span>{totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0}%</span>
                      </div>
                      <div className="h-0.5 bg-grey-10 overflow-hidden">
                        <div className="h-full bg-green transition-all duration-500" style={{ width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%` }} />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="w-6 h-px bg-grey-20" />
                      <span className="overline text-grey-40">
                        {successCount} Responses
                        {activePack && contextEnabled && (
                          <span className="text-green ml-2">● {activePack.name}</span>
                        )}
                      </span>
                    </div>
                  )}

                  {status === "complete" && (
                    <div className="flex items-center gap-2">
                      {!synthesis && anthropicKey && successCount >= 2 && (
                        <div className="flex items-center gap-3">
                          <button onClick={() => { setSynthesisError(null); runSynthesis(
                            "manual",
                            [...responses.values()].filter((r) => r.status === "complete")
                          ); }}
                            className="cta-text px-5 py-2 bg-green text-cream hover:bg-green-hover transition-colors duration-300">
                            {synthesisError ? "Retry Synthesis" : "Synthesize All"}
                          </button>
                          {synthesisError && (
                            <span className="text-xs text-red-600">{synthesisError}</span>
                          )}
                        </div>
                      )}
                      {!synthesis && !anthropicKey && (
                        <button onClick={() => setShowKeyInput(true)}
                          className="cta-text px-5 py-2 border border-green text-green hover:bg-green-light transition-colors duration-300">
                          Add Anthropic Key to Synthesize
                        </button>
                      )}
                      {retryableCount > 0 && (
                        <button onClick={handleRetryFailed}
                          className="cta-text px-5 py-2 border border-gold text-gold hover:bg-gold/10 transition-colors duration-300">
                          Retry {retryableCount} Failed
                        </button>
                      )}
                      {successCount >= 1 && (
                        <button onClick={() => {
                          const successful = [...responses.values()].filter((r) => r.status === "complete" && r.response);
                          const output = successful.map((r) =>
                            `=== ${r.modelName} ===\n${r.response}`
                          ).join("\n\n---\n\n");
                          const header = `PROMPT: ${prompt}\n\nCONTENT:\n${content}\n\n${"=".repeat(60)}\n${successful.length} MODEL RESPONSES:\n${"=".repeat(60)}\n\n`;
                          navigator.clipboard.writeText(header + output);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                          className="cta-text px-5 py-2 border border-border text-grey-50 hover:border-green hover:text-green transition-colors duration-300">
                          {copied ? "Copied!" : "Copy All to Clipboard"}
                        </button>
                      )}
                      {compareIds.size >= 2 && (
                        <button onClick={() => setShowCompare(true)}
                          className="cta-text px-5 py-2 border border-border text-grey-50 hover:border-green hover:text-green transition-colors duration-300">
                          Compare ({compareIds.size})
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Response Cards */}
                <div className="space-y-3">
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
        </main>
      </div>
    </div>
  );
}
