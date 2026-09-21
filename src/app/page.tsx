"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ContextPack, ModelInfo } from "@/lib/types";
import { SNAPSHOT_CHECKED_AT, COUNCIL_IDS, COUNCIL_MAX_TOKENS, SNAPSHOT_MODELS, SYNTHESIS_IDS, SYNTHESIS_MAX_TOKENS, setRuntimeCatalog, type SynthesisModelKey } from "@/lib/model-catalog";
import { estimateReviewCost, estimateTokens, getModelsFilteredByContext } from "@/lib/model-registry";
import { DEFAULT_TEMPLATES, type PromptTemplate } from "@/lib/prompts";
import { DEFAULT_RUN_PRESETS, selectModelsForPreset, type ModelSelectionPreset } from "@/lib/run-presets";
import { getActiveProjectProfileId, getProjectProfiles, setActiveProjectProfileId, type ProjectProfile } from "@/lib/project-profiles";
import { buildContextString, getActivePackId, getContextPacks } from "@/lib/context-packs";
import { getCachedFileContent } from "@/lib/context-cache";
import { checkpointCost, checkpointMarkdown, sameReviewInput, type RunCheckpoint } from "@/lib/run-checkpoint";
import { useReviewRun } from "@/lib/use-review-run";
import { prepareCloudAccess } from "@/lib/client-api";
import { ModelPicker } from "@/components/model-picker";
import { ContextPanel } from "@/components/context-panel";
import { ResponseCard } from "@/components/response-card";
import { SynthesisView } from "@/components/synthesis-view";
import { SynthesisComparisonView } from "@/components/synthesis-comparison";
import { CompareView } from "@/components/compare-view";
import { FindingTracker } from "@/components/finding-tracker";
import { diffSourceDocuments } from "@/lib/finding-tracking";
import type { SourceDocument } from "@/lib/review-policy";
import { DEFAULT_DECISION_MODES, type DecisionMode } from "@/lib/decision-gate";

const field = "mt-1 w-full min-w-0 border border-border bg-white px-3 py-2.5 text-sm text-ink focus:border-green";
const button = "min-h-11 border border-border px-3 py-2 text-sm text-green hover:bg-green-light disabled:opacity-50";

export default function Home() {
  const review = useReviewRun();
  const [content, setContent] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_RUN_PRESETS[0].prompt);
  const [allModels, setAllModels] = useState<ModelInfo[]>(SNAPSHOT_MODELS);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(COUNCIL_IDS.balanced));
  const [catalogNote, setCatalogNote] = useState(`Saved catalog · checked ${SNAPSHOT_CHECKED_AT.slice(0, 10)}`);
  const [apiKey, setApiKey] = useState("");
  const [githubPat, setGithubPat] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [synthesisModel, setSynthesisModel] = useState<SynthesisModelKey>("sonnet");
  const [maxCost, setMaxCost] = useState(1.5);
  const [maxTokens, setMaxTokens] = useState(COUNCIL_MAX_TOKENS);
  const [synthesisMaxTokens, setSynthesisMaxTokens] = useState(SYNTHESIS_MAX_TOKENS);
  const [reasoning, setReasoning] = useState("medium");
  const [allowFallback, setAllowFallback] = useState(false);
  const [backgroundAvailable, setBackgroundAvailable] = useState(false);
  const [background, setBackground] = useState(false);
  const [adaptive, setAdaptive] = useState(false);
  const [risk, setRisk] = useState<"standard" | "high">("standard");
  const [jevEnabled, setJevEnabled] = useState(true);
  const [preReviewMode, setPreReviewMode] = useState<DecisionMode>(DEFAULT_DECISION_MODES.preReview);
  const [escalationMode, setEscalationMode] = useState<DecisionMode>(DEFAULT_DECISION_MODES.escalation);
  const [projectKey, setProjectKey] = useState("default");
  const [sourceDocuments, setSourceDocuments] = useState<SourceDocument[]>([]);
  const [sourceContent, setSourceContent] = useState("");
  const [profiles, setProfiles] = useState<ProjectProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [templateId, setTemplateId] = useState("plan-review");
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>([]);
  const [activePack, setActivePack] = useState<ContextPack | null>(null);
  const [contextEnabled, setContextEnabled] = useState(false);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [restoredContext, setRestoredContext] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState("");
  const [prLoading, setPrLoading] = useState(false);
  const [preflight, setPreflight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"setup" | "results">("setup");
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      void fetch("/api/reviews/capabilities").then(response => response.json()).then(data => {
        if (mounted) { setBackgroundAvailable(Boolean(data.background)); setBackground(Boolean(data.background)); }
      }).catch(() => {});
      const response = await fetch("/api/models").catch(() => null);
      const catalog = response?.ok ? await response.json() : null;
      if (!mounted) return;
      if (catalog?.models?.length) {
        setAllModels(catalog.models);
        setCatalogNote(`${catalog.stale ? "Saved" : "Live"} catalog · checked ${String(catalog.checkedAt).slice(0, 10)}${catalog.warning ? ` · ${catalog.warning}` : ""}`);
      }
      const storedKey = sessionStorage.getItem("openrouter-api-key") || localStorage.getItem("openrouter-api-key") || "";
      setApiKey(storedKey); await prepareCloudAccess(storedKey);
      setRememberKey(Boolean(localStorage.getItem("openrouter-api-key")));
      const storedSynth = localStorage.getItem("synthesis-model");
      if (storedSynth && storedSynth in SYNTHESIS_IDS) setSynthesisModel(storedSynth as SynthesisModelKey);
      setGithubPat(localStorage.getItem("github-pat") || "");
      const storedProfiles = getProjectProfiles();
      setProfiles(storedProfiles);
      const storedProfileId = localStorage.getItem("model-prism-active-profile");
      if (storedProfileId) {
        setProfileId(getActiveProjectProfileId());
        const profile = storedProfiles.find((item) => item.id === storedProfileId);
        if (profile) {
          const preset = DEFAULT_RUN_PRESETS.find((item) => item.id === profile.defaultRunPresetId);
          if (preset) { setTemplateId(preset.id); setPrompt(preset.prompt); }
          setSelected(selectModelsForPreset(catalog?.models ?? SNAPSHOT_MODELS, profile.defaultModelPreset));
          setSynthesisModel(profile.defaultSynthesisModel); setMaxCost(profile.defaultMaxCost);
        }
      }
      try { setCustomTemplates(JSON.parse(localStorage.getItem("custom-templates") || "[]")); } catch { /* Ignore corrupt saved templates. */ }
      const pack = getContextPacks().find((item) => item.id === getActivePackId());
      if (pack) {
        const files: Record<string, string> = {};
        for (const path of pack.selectedFiles) {
          const cached = await getCachedFileContent(pack.repo, pack.branch, path);
          if (cached) files[path] = cached.content;
        }
        if (mounted) { setActivePack(pack); setContextEnabled(true); setFileContents(files); }
      }
      const rerun = sessionStorage.getItem("rerun");
      if (rerun && mounted) {
        try { const data = JSON.parse(rerun); setContent(data.content || ""); setPrompt(data.prompt || DEFAULT_RUN_PRESETS[0].prompt); } catch { /* Invalid old rerun. */ }
        sessionStorage.removeItem("rerun");
      }
    }
    void load().catch(() => { if (mounted) setError("Some saved settings could not load. You can still configure a new review."); });
    return () => { mounted = false; };
  }, []);

  const context = restoredContext ?? (contextEnabled && activePack ? buildContextString(activePack, fileContents) : "");
  const missingContext = contextEnabled && activePack && restoredContext === null ? activePack.selectedFiles.filter((path) => !Object.hasOwn(fileContents, path)) : [];
  const effectiveProjectKey = activePack && contextEnabled ? activePack.repo : projectKey.trim() || "default";
  const input = { content, prompt, context, reasoningEffort: reasoning, projectKey: effectiveProjectKey };
  const sameInput = Boolean(review.run && sameReviewInput(review.run, input));
  const inputTokens = estimateTokens(content + prompt + context);
  const { tooSmall } = getModelsFilteredByContext(allModels, inputTokens, maxTokens);
  const chosenModels = allModels.filter((model) => selected.has(model.id));
  const synth = allModels.find((model) => model.id === SYNTHESIS_IDS[synthesisModel]) ?? SNAPSHOT_MODELS.find((model) => model.id === SYNTHESIS_IDS[synthesisModel])!;
  const costEstimate = estimateReviewCost(chosenModels, inputTokens, synth, maxTokens, synthesisMaxTokens);
  const busy = review.busy || preflight;
  const responses = review.run?.responses ?? [];
  const completeCount = responses.filter((response) => response.status === "complete").length;
  const templates = useMemo(() => [...DEFAULT_RUN_PRESETS, ...DEFAULT_TEMPLATES, ...customTemplates], [customTemplates]);

  function applyPreset(id: string) {
    setTemplateId(id);
    const template = templates.find((item) => item.id === id);
    if (template) setPrompt(template.prompt);
    const preset = DEFAULT_RUN_PRESETS.find((item) => item.id === id);
    if (preset) { setSelected(selectModelsForPreset(allModels, preset.modelPreset, tooSmall)); setSynthesisModel(preset.synthesisModel); setMaxCost(preset.maxCost); }
  }
  function selectPreset(preset: ModelSelectionPreset) { setSelected(selectModelsForPreset(allModels, preset, tooSmall)); }
  function saveKey(value: string, remember = rememberKey) {
    setApiKey(value); sessionStorage.setItem("openrouter-api-key", value);
    if (remember) localStorage.setItem("openrouter-api-key", value); else localStorage.removeItem("openrouter-api-key");
  }
  function restore(snapshot: RunCheckpoint) {
    review.restore(snapshot); setContent(snapshot.content); setPrompt(snapshot.prompt); setRestoredContext(snapshot.context);
    setReasoning(snapshot.reasoningEffort); setSelected(new Set(snapshot.models.map((model) => model.id)));
    setMaxCost(snapshot.maxCost); setMaxTokens(snapshot.maxTokens); setSynthesisMaxTokens(snapshot.synthesisMaxTokens);
    setSynthesisModel((Object.entries(SYNTHESIS_IDS).find(([, id]) => id === snapshot.synthesisModel)?.[0] as SynthesisModelKey) ?? "sonnet");
    setMobileTab("results");
    setSourceDocuments(snapshot.sources ?? []); setSourceContent(snapshot.content);
    setProjectKey(snapshot.projectKey ?? "default"); setAdaptive(snapshot.adaptive?.enabled ?? false);
    const restoredModes = snapshot.decisionModes ?? DEFAULT_DECISION_MODES;
    setPreReviewMode(restoredModes.preReview); setEscalationMode(restoredModes.escalation);
    setJevEnabled(restoredModes.preReview !== "off" || restoredModes.escalation !== "off");
    if (snapshot.background) setBackground(true);
  }
  async function start(secondPass = false, extraIds: string[] = []) {
    if (busy) return;
    setError(null);
    if (!apiKey.trim()) { setShowKeys(true); setError("Add your OpenRouter key to run the council and synthesis."); return; }
    if (!content.trim() || !prompt.trim()) { setError("Add content and review instructions."); setMobileTab("setup"); return; }
    if (missingContext.length) { setError(`Load the ${missingContext.length} missing context file(s), or turn context off before running.`); return; }
    if (!Number.isFinite(maxCost) || maxCost <= 0) { setError("Set a positive spending limit."); return; }
    setPreflight(true);
    try {
      const response = await fetch("/api/models?refresh=1", { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("Unable to verify current model availability. Refresh and try again.");
      const catalog = await response.json();
      if (catalog.stale || !catalog.models?.length) throw new Error("The live catalog is unavailable. Refresh before starting a paid review.");
      const currentModels: ModelInfo[] = catalog.models;
      await prepareCloudAccess(apiKey);
      const ids = new Set([...selected, ...extraIds]);
      const models = currentModels.filter((model) => ids.has(model.id));
      const missing = [...ids].filter((id) => !models.some((model) => model.id === id));
      if (missing.length) throw new Error(`Unavailable models: ${missing.join(", ")}. Choose a refreshed roster.`);
      if (models.length < 2) throw new Error("Select at least two reviewers to compare their answers.");
      if (!currentModels.some((model) => model.id === SYNTHESIS_IDS[synthesisModel])) throw new Error("The selected synthesizer is unavailable. Choose another.");
      setRuntimeCatalog(currentModels); setAllModels(currentModels); setSelected(ids); setCatalogNote(`Live catalog · checked ${String(catalog.checkedAt).slice(0, 10)}`);
      setMobileTab("results"); setCompareIds(new Set());
      const sources = sameInput && review.run?.sources ? review.run.sources : [
        ...(sourceContent === content ? sourceDocuments : []),
        ...(contextEnabled && activePack && restoredContext === null ? activePack.selectedFiles.map(path => ({ id: `file:${path}`, path, text: fileContents[path] })) : []),
      ].filter((source, index, all) => all.findIndex(item => item.id === source.id) === index);
      await review.start({ ...input, apiKey, models, catalog: currentModels, synthesisModel: SYNTHESIS_IDS[synthesisModel], maxCost, maxTokens, synthesisMaxTokens, allowPaidFallback: allowFallback,
        background, adaptive: background && adaptive, risk,
        decisionModes: {
          preReview: background && jevEnabled ? preReviewMode : "off",
          escalation: background && jevEnabled ? escalationMode : "off",
        },
        sources,
        baselineRunId: sameInput ? review.run?.baselineRunId : (review.run?.projectKey ?? "default") === effectiveProjectKey ? review.run?.id : undefined,
        contextMetadata: activePack && contextEnabled ? JSON.stringify({ packId: activePack.id, packName: activePack.name, repo: activePack.repo, branch: activePack.branch, files: activePack.selectedFiles }) : undefined, secondPass });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to start review"); }
    finally { setPreflight(false); }
  }
  async function loadPr() {
    setPrLoading(true); setError(null);
    try {
      const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
      if (!match) throw new Error("Enter a GitHub pull request URL.");
      const url = `https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`;
      const headers: Record<string, string> = githubPat ? { Authorization: `Bearer ${githubPat}` } : {};
      const before = await fetch(url, { headers, signal: AbortSignal.timeout(30000), cache: "no-store" });
      if (!before.ok) throw new Error(`Could not load pull request (${before.status})`);
      const metadata = await before.json();
      const response = await fetch(url, { headers: { Accept: "application/vnd.github.diff", ...headers }, signal: AbortSignal.timeout(30000), cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load pull request (${response.status}). Check the GitHub token in Settings for private repositories.`);
      const diff = await response.text();
      const after = await fetch(url, { headers, signal: AbortSignal.timeout(30000), cache: "no-store" });
      if (!after.ok) throw new Error("Could not verify the pull request revision. Try loading it again.");
      const latest = await after.json();
      if (latest.head.sha !== metadata.head.sha || latest.base.sha !== metadata.base.sha) throw new Error("The pull request changed while loading. Load it again to get consistent file citations.");
      setContent(diff); setSourceContent(diff); setProjectKey(`${match[1]}/${match[2]}`);
      setSourceDocuments(diffSourceDocuments(diff, metadata.head.repo.full_name, metadata.head.sha)); applyPreset("code-review");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "PR load failed"); }
    finally { setPrLoading(false); }
  }

  return <div className="min-h-screen bg-cream text-ink pb-28">
    <header className="bg-green text-cream">
      <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-8 flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="font-display text-2xl font-bold">Model Prism</h1><p className="text-xs text-cream/80 mt-1">One input. Independent perspectives. Traceable findings.</p></div>
        <nav aria-label="Main navigation" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link href="/history">History</Link><Link href="/models">Models</Link><Link href="/hooks">Hooks</Link><Link href="/settings">Settings</Link>
          <button onClick={() => setShowKeys(!showKeys)} aria-expanded={showKeys}>{apiKey ? "API key" : "Connect key"}</button>
        </nav>
      </div>
    </header>
    {showKeys && <section aria-label="API connection" className="border-b border-border bg-white p-4 sm:px-8 space-y-3">
      <label className="block max-w-xl text-sm">OpenRouter API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => saveKey(event.target.value)} className={field} placeholder="sk-or-…" /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rememberKey} onChange={(event) => { setRememberKey(event.target.checked); saveKey(apiKey, event.target.checked); }} />Remember key on this device</label>
      <p className="text-sm text-grey-50">One key covers reviewers and synthesis. Browser reviews call OpenRouter directly; background reviews temporarily encrypt your key on the server. Saved review results never include the key. Remembered keys are stored unencrypted on this device.</p>
    </section>}
    <div className="mx-auto max-w-[1500px]">
      {review.restorable && <div className="m-4 border border-green bg-green-light p-4 flex flex-wrap items-center gap-3 text-sm">
        <span>Saved review from {new Date(review.restorable.updatedAt).toLocaleString()} · {review.restorable.responses.filter((response) => response.status === "complete").length} completed answers.</span>
        <button className={button} disabled={busy} onClick={() => restore(review.restorable!)}>Restore review</button><button className={button} onClick={review.dismissRestore}>Dismiss</button>
      </div>}
      {(error || review.saveError) && <div role="alert" className="m-4 border border-red-300 bg-red-50 p-4 text-sm text-red-800 space-y-2">
        {error && <p>{error}</p>}{review.saveError && <p>{review.saveError} <button onClick={review.retrySave} className="underline">Retry save</button></p>}
      </div>}
      <div className="sticky top-0 z-10 grid grid-cols-2 bg-cream border-b border-border lg:hidden" role="tablist" aria-label="Review workspace">
        {(["setup", "results"] as const).map((tab) => <button key={tab} role="tab" aria-selected={mobileTab === tab} aria-controls={`review-${tab}`} onClick={() => setMobileTab(tab)} className={`min-h-12 text-sm ${mobileTab === tab ? "bg-green text-cream" : "text-green"}`}>{tab === "setup" ? "Setup" : `Results${responses.length ? ` (${completeCount})` : ""}`}</button>)}
      </div>
      <div className="grid lg:grid-cols-[minmax(360px,0.85fr)_minmax(0,1.15fr)]">
        <section id="review-setup" aria-label="Review setup" className={`${mobileTab === "setup" ? "block" : "hidden"} min-w-0 bg-white p-4 sm:p-6 lg:block lg:border-r border-border`}>
          <fieldset disabled={busy} className="min-w-0 space-y-6 disabled:opacity-70">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Project for finding history<input value={activePack && contextEnabled ? activePack.repo : projectKey} disabled={Boolean(activePack && contextEnabled)} onChange={event => setProjectKey(event.target.value)} maxLength={200} className={field} placeholder="e.g. owner/repository" /></label>
              <label className="text-sm">Project profile<select className={field} value={profileId} onChange={(event) => {
                const id = event.target.value; setProfileId(id); setActiveProjectProfileId(id);
                const profile = profiles.find((item) => item.id === id);
                if (profile) {
                  applyPreset(profile.defaultRunPresetId); setSelected(selectModelsForPreset(allModels, profile.defaultModelPreset, tooSmall)); setSynthesisModel(profile.defaultSynthesisModel); setMaxCost(profile.defaultMaxCost);
                  const pack = getContextPacks().find((item) => item.name === profile.defaultContextPackName);
                  if (pack) { setActivePack(pack); setContextEnabled(true); setRestoredContext(null); setFileContents({}); }
                }
              }}><option value="">Custom review</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
              <label className="text-sm">Review template<select className={field} value={templateId} onChange={(event) => applyPreset(event.target.value)}>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
            </div>
            <div><label htmlFor="review-content" className="block text-sm font-medium">Content to review</label><textarea id="review-content" value={content} onChange={(event) => setContent(event.target.value)} className={`${field} min-h-48 resize-y font-mono`} placeholder="Paste your plan, code, diff, or question…" /></div>
            <details className="border border-border p-3"><summary className="cursor-pointer text-sm text-green">Load a GitHub pull request</summary><div className="mt-3 flex flex-wrap gap-2"><input aria-label="GitHub pull request URL" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} className={`${field} flex-1 basis-60`} placeholder="https://github.com/owner/repo/pull/123" /><button className={button} onClick={loadPr} disabled={prLoading || !prUrl}>{prLoading ? "Loading…" : "Load PR"}</button></div></details>
            <div><label htmlFor="review-instructions" className="block text-sm font-medium">Review instructions</label><textarea id="review-instructions" value={prompt} onChange={(event) => setPrompt(event.target.value)} className={`${field} min-h-28 resize-y`} /></div>
            {restoredContext !== null ? <div className="border border-green p-3 text-sm">This review uses its saved context ({estimateTokens(restoredContext).toLocaleString()} estimated tokens).<button className="mt-2 block underline text-green" onClick={() => setRestoredContext(null)}>Choose different context</button></div> :
              <ContextPanel githubPat={githubPat} openrouterKey={apiKey} activePack={activePack} contextEnabled={contextEnabled} contentText={content} fileContents={fileContents} onPackChange={setActivePack} onContextEnabledChange={setContextEnabled} onFileContentsChange={setFileContents} onContextTokensChange={() => {}} />}
            <div><h2 className="font-display text-xl font-bold mb-3">Choose your council</h2><p className="text-sm text-grey-50 mb-3">Start with five complementary reviewers. Add advanced reviewers when a disagreement needs another perspective.</p>
              <ModelPicker models={allModels} selected={selected} tooSmall={tooSmall} onToggle={(id) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onSelectPreset={selectPreset} onClearAll={() => setSelected(new Set())} />
              <p className="mt-3 text-xs text-grey-50">{catalogNote}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Synthesis model<select value={synthesisModel} onChange={(event) => setSynthesisModel(event.target.value as SynthesisModelKey)} className={field}>{Object.entries(SYNTHESIS_IDS).map(([key, id]) => <option key={key} value={key}>{SNAPSHOT_MODELS.find((model) => model.id === id)?.name ?? id}</option>)}</select></label>
              <label className="text-sm">Spending limit (USD)<input type="number" min="0.01" step="0.25" value={maxCost} onChange={(event) => setMaxCost(Number(event.target.value))} className={field} /></label>
              <label className="text-sm">Reasoning effort<select value={reasoning} onChange={(event) => setReasoning(event.target.value)} className={field}>{["low", "medium", "high", "max"].map((effort) => <option key={effort}>{effort}</option>)}</select></label>
              <label className="text-sm">Reviewer output budget<select value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} className={field}>{[8192, 16384, 32768].map((tokens) => <option key={tokens} value={tokens}>{tokens.toLocaleString()} tokens</option>)}</select></label>
              <label className="text-sm">Synthesis output budget<select value={synthesisMaxTokens} onChange={(event) => setSynthesisMaxTokens(Number(event.target.value))} className={field}>{[16384, 32768, 65536].map((tokens) => <option key={tokens} value={tokens}>{tokens.toLocaleString()} tokens</option>)}</select></label>
            </div>
            <label className="flex gap-2 items-start text-sm"><input type="checkbox" checked={allowFallback} onChange={(event) => setAllowFallback(event.target.checked)} className="mt-1" />Allow a paid replacement for an unavailable free reviewer, within the spending limit.</label>
            {backgroundAvailable && <div className="border border-border p-3 space-y-3 text-sm">
              <label className="flex gap-2 items-start"><input type="checkbox" checked={background} onChange={event => setBackground(event.target.checked)} className="mt-1" />Keep running after you close this tab</label>
              <p className="text-xs text-grey-50">Background reviews encrypt your provider key on the server for this run. It expires after 24 hours and is cleared when the run ends or during daily cleanup. Progress and spending remain in private History.</p>
              {background && <><label className="flex gap-2 items-start"><input type="checkbox" checked={adaptive} onChange={event => setAdaptive(event.target.checked)} className="mt-1" />Adaptive council: start with three reviewers, then add selected reviewers when concerns remain.</label>
              <label className="block">Review risk<select className={field} value={risk} onChange={event => setRisk(event.target.value as "standard" | "high")}><option value="standard">Standard</option><option value="high">High — always use every selected reviewer</option></select></label>
              <div className="border-t border-border pt-3 space-y-3">
                <label className="flex gap-2 items-start"><input type="checkbox" checked={jevEnabled} onChange={event => setJevEnabled(event.target.checked)} className="mt-1" />Use Jev decision gates for this background review.</label>
                {jevEnabled && <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">Pre-review depth<select className={field} value={preReviewMode} onChange={event => setPreReviewMode(event.target.value as DecisionMode)}>{(["off","shadow","assist","enforce"] as const).map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>
                  <label className="block">Post-synthesis escalation<select className={field} value={escalationMode} onChange={event => setEscalationMode(event.target.value as DecisionMode)}>{(["off","shadow","assist","enforce"] as const).map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>
                </div>}
                <p className="text-xs text-grey-50">Shadow only records Jev&apos;s judgment. Assist may add scrutiny but cannot remove deterministic safeguards. Enforce may reduce adaptive work only on high-confidence, standard-risk cases; explicit High risk still uses the full council.</p>
              </div>
              {adaptive && <p className="text-xs text-grey-50">Adaptive escalation may require a second synthesis and cost more than a fixed council. Your spending limit still applies.</p>}</>}
            </div>}
            <p className="text-xs text-grey-50 leading-relaxed">The limit covers this run’s reviewers, synthesis, retries, and second pass. Unknown charges after an interrupted request reserve the full request ceiling. Provider billing may continue briefly after Stop. Reasoning uses the closest effort supported by each model.</p>
          </fieldset>
        </section>
        <section id="review-results" aria-label="Review results" className={`${mobileTab === "results" ? "block" : "hidden"} min-w-0 p-4 sm:p-6 lg:block space-y-5`}>
          {!review.run ? <div className="py-12 lg:py-24"><p className="overline text-green">A clearer review</p><h2 className="font-display text-4xl leading-tight mt-4 max-w-lg">See what one model might miss.</h2><p className="text-grey-50 mt-5 max-w-md leading-relaxed">Your council reviews the same frozen input. Compare their answers, inspect disagreements, and trace findings back to the supplied evidence.</p><ol className="mt-8 space-y-4 text-sm"><li>01 · Add your content and context</li><li>02 · Choose a council and spending limit</li><li>03 · Review the evidence and decide what to change</li></ol></div> : <>
            <div className="flex flex-wrap justify-between gap-3 text-sm"><p role="status" aria-live="polite">{review.run.status === "synthesizing" ? "Synthesizing completed answers…" : `${completeCount} of ${review.run.models.length} reviewers complete · ${review.run.status}`}</p><Link className="text-green underline" href={`/runs/${review.run.id}`}>Saved review</Link></div>
            {!sameInput && <p className="border border-gold p-3 text-sm">These results belong to the previous input. Running your edited content creates a new review.</p>}
            {review.run.error && <p role="status" className="border border-gold bg-white p-3 text-sm">{review.run.error}</p>}
            {review.run.background && <p className="text-sm text-green" role="status">{review.run.background.phase}{["queued", "running"].includes(review.run.background.state) ? " · You can close this tab and return from History." : ""}</p>}
            {review.run.adaptive?.enabled && <p className="text-xs text-grey-50">Adaptive council · {review.run.adaptive.initialIds.length} initial reviewers · {review.run.adaptive.escalatedIds.length} added{review.run.adaptive.reasons.length ? ` · ${review.run.adaptive.reasons.join("; ")}` : ""}</p>}
            {!!review.run.decisionGates?.length && <details className="border border-border bg-white p-3 text-xs"><summary className="cursor-pointer text-green">Jev decision gates · {review.run.decisionGates.length} recorded</summary><div className="mt-2 space-y-1">{review.run.decisionGates.map((gate, index) => <p key={`${gate.key}-${gate.execution}-${index}`}><strong>{gate.key}</strong> · {gate.mode} · {gate.deterministicDecision} → {gate.effectiveDecision} · {gate.action}{gate.selectedProbability !== undefined ? ` · p=${gate.selectedProbability.toFixed(2)}` : ""}{gate.costUsd !== undefined ? ` · ${gate.costUsd.toFixed(6)}` : ""}{gate.error ? ` · ${gate.error}` : ""}</p>)}</div></details>}
            <div className="flex flex-wrap gap-2">
              <button className={button} onClick={async () => { try { await navigator.clipboard.writeText(checkpointMarkdown(review.run!)); setCopied(true); } catch { setError("Clipboard unavailable. Open the saved review to export it."); } }}>{copied ? "Copied" : "Copy full review"}</button>
              {compareIds.size >= 2 && <button className={button} onClick={() => setShowCompare(true)}>Compare {compareIds.size} answers</button>}
              {sameInput && review.run.synthesis && (review.run.synthesis.disagreements.length > 0 || review.run.synthesis.findings?.some((finding) => ["critical", "high"].includes(finding.severity))) && <button className={button} disabled={busy} onClick={() => start(false, COUNCIL_IDS.frontier.filter((id) => !review.run!.models.some((model) => model.id === id)))}>Add advanced reviewers</button>}
            </div>
            {review.run.synthesis && <SynthesisView synthesis={review.run.synthesis} onSecondPass={sameInput && !busy ? () => start(true) : undefined} secondPassLoading={busy} />}
            {review.run.secondPass && review.run.synthesis && <><SynthesisComparisonView previous={review.run.synthesis} next={review.run.secondPass} /><SynthesisView synthesis={review.run.secondPass} title="Second pass" /></>}
            {review.run.synthesis && !busy && <FindingTracker runId={review.run.id} revision={review.run.revision} />}
            <h2 className="font-display text-2xl">Council responses</h2>
            {responses.map((response) => <ResponseCard key={response.requestedModel ?? response.model} response={response} compareMode={!busy} isComparing={compareIds.has(response.model)} onToggleCompare={() => setCompareIds((current) => { const next = new Set(current); if (next.has(response.model)) next.delete(response.model); else next.add(response.model); return next; })} />)}
          </>}
        </section>
      </div>
    </div>
    <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-cream/95 backdrop-blur px-4 py-3 safe-bottom">
      <div className="mx-auto max-w-[1440px] flex items-center justify-between gap-3">
        <div className="text-sm min-w-0"><p className="font-medium">{selected.size} reviewers · {review.run ? `$${checkpointCost(review.run).toFixed(3)} recorded` : `~$${costEstimate.toFixed(2)} estimated`}</p><p className="text-xs text-grey-50 mt-1">${maxCost.toFixed(2)} limit · {inputTokens.toLocaleString()} input tokens{review.run?.usage.some((usage) => usage.costSource !== "provider") ? " · includes estimates/reserves" : ""}</p></div>
        {review.busy ? <button className="min-h-12 shrink-0 bg-red-700 text-white px-6 py-3" onClick={review.stop}>Stop</button> : <button data-testid="run-button" className="min-h-12 shrink-0 bg-green text-cream px-5 py-3 text-sm font-medium disabled:opacity-50" onClick={() => start()} disabled={busy || !content.trim() || !selected.size}>{preflight ? "Checking…" : review.run && sameInput ? "Resume / add models" : review.run ? "Run edited input" : "Run council"}</button>}
      </div>
    </footer>
    {showCompare && <CompareView responses={responses.filter((response) => compareIds.has(response.model))} onClose={() => setShowCompare(false)} />}
  </div>;
}
