"use client";

import { useState, useEffect, useCallback } from "react";
import { DEFAULT_TEMPLATES, PromptTemplate } from "@/lib/prompts";
import { DEFAULT_RUN_PRESETS, ModelSelectionPreset } from "@/lib/run-presets";
import { BUILT_IN_PROJECT_PROFILES, createProjectProfile, getCustomProjectProfiles, ProjectProfile, saveCustomProjectProfiles } from "@/lib/project-profiles";
import { validatePat, getRateLimitInfo } from "@/lib/github";
import { getCacheSize, getCacheEntryCount, clearAllCache } from "@/lib/context-cache";
import { PatValidationResult } from "@/lib/types";

function getStoredKey(key: string): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(key) || "";
}

function getCustomTemplates(): PromptTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem("custom-templates") || "[]");
  } catch {
    return [];
  }
}

export default function SettingsPage() {
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [synthesisModel, setSynthesisModel] = useState("sonnet");
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>([]);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [customProfiles, setCustomProfiles] = useState<ProjectProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [profileDescription, setProfileDescription] = useState("");
  const [profileRunPreset, setProfileRunPreset] = useState(DEFAULT_RUN_PRESETS[0].id);
  const [profileModelPreset, setProfileModelPreset] = useState<ModelSelectionPreset>("diverse");
  const [profileSynthesisModel, setProfileSynthesisModel] = useState<"sonnet" | "opus">("opus");
  const [profileMaxCost, setProfileMaxCost] = useState(1.5);
  const [profileContextName, setProfileContextName] = useState("");
  const [saved, setSaved] = useState(false);

  // GitHub PAT state
  const [githubPat, setGithubPat] = useState("");
  const [patValidation, setPatValidation] = useState<PatValidationResult | null>(null);
  const [patValidating, setPatValidating] = useState(false);

  // Cache state
  const [cacheSize, setCacheSize] = useState(0);
  const [cacheEntries, setCacheEntries] = useState(0);
  const [cacheClearing, setCacheClearing] = useState(false);

  useEffect(() => {
    setOpenrouterKey(getStoredKey("openrouter-api-key"));
    setAnthropicKey(getStoredKey("anthropic-api-key"));
    setAdminToken(getStoredKey("model-prism-admin-token"));
    setSynthesisModel(getStoredKey("synthesis-model") || "sonnet");
    setGithubPat(getStoredKey("github-pat"));
    setCustomTemplates(getCustomTemplates());
    setCustomProfiles(getCustomProjectProfiles());

    // Load cache stats
    (async () => {
      setCacheSize(await getCacheSize());
      setCacheEntries(await getCacheEntryCount());
    })();
  }, []);

  const saveKeys = () => {
    localStorage.setItem("openrouter-api-key", openrouterKey);
    localStorage.setItem("anthropic-api-key", anthropicKey);
    localStorage.setItem("model-prism-admin-token", adminToken);
    localStorage.setItem("synthesis-model", synthesisModel);
    localStorage.setItem("github-pat", githubPat);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleValidatePat = useCallback(async () => {
    if (!githubPat.trim()) return;
    setPatValidating(true);
    setPatValidation(null);
    try {
      const result = await validatePat(githubPat);
      setPatValidation(result);
    } catch (err) {
      setPatValidation({ valid: false, message: (err as Error).message || "Validation failed" });
    }
    setPatValidating(false);
  }, [githubPat]);

  const handleClearCache = useCallback(async () => {
    setCacheClearing(true);
    await clearAllCache();
    setCacheSize(0);
    setCacheEntries(0);
    setCacheClearing(false);
  }, []);

  const addTemplate = () => {
    if (!newName.trim() || !newPrompt.trim()) return;
    const template: PromptTemplate = {
      id: `custom_${Date.now()}`,
      name: newName.trim(),
      prompt: newPrompt.trim(),
    };
    const updated = [...customTemplates, template];
    setCustomTemplates(updated);
    localStorage.setItem("custom-templates", JSON.stringify(updated));
    setNewName("");
    setNewPrompt("");
  };

  const removeTemplate = (id: string) => {
    const updated = customTemplates.filter((t) => t.id !== id);
    setCustomTemplates(updated);
    localStorage.setItem("custom-templates", JSON.stringify(updated));
  };

  const addProfile = () => {
    if (!profileName.trim()) return;
    const profile = createProjectProfile({
      name: profileName.trim(),
      description: profileDescription.trim() || "Custom project profile",
      defaultRunPresetId: profileRunPreset,
      defaultModelPreset: profileModelPreset,
      defaultSynthesisModel: profileSynthesisModel,
      defaultMaxCost: profileMaxCost,
      defaultContextPackName: profileContextName.trim() || undefined,
    });
    const updated = [...customProfiles, profile];
    setCustomProfiles(updated);
    saveCustomProjectProfiles(updated);
    setProfileName("");
    setProfileDescription("");
    setProfileContextName("");
  };

  const removeProfile = (id: string) => {
    const updated = customProfiles.filter((profile) => profile.id !== id);
    setCustomProfiles(updated);
    saveCustomProjectProfiles(updated);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <a href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <span className="text-sm font-bold">P</span>
            </div>
            <h1 className="text-lg font-semibold">Model Prism</h1>
          </a>
          <span className="text-neutral-600">/</span>
          <span className="text-sm text-neutral-400">Settings</span>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-6 space-y-8">
        {/* API Keys */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-neutral-300">API Keys</h2>
          <p className="text-xs text-neutral-500">
            Keys are stored in your browser only. Never sent to our servers.
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-neutral-400 mb-1">OpenRouter API Key</label>
              <input
                type="password"
                value={openrouterKey}
                onChange={(e) => setOpenrouterKey(e.target.value)}
                placeholder="sk-or-..."
                className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">Anthropic API Key (for synthesis + brief enhancement)</label>
              <input
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">Admin Token (optional, for protected history/save APIs)</label>
              <input
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="Only needed when MODEL_PRISM_ADMIN_TOKEN is set"
                className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">Default Synthesis Model</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setSynthesisModel("sonnet")}
                  className={`text-xs px-4 py-2 rounded-lg border transition-colors ${
                    synthesisModel === "sonnet"
                      ? "border-violet-500 bg-violet-500/10 text-violet-200"
                      : "border-neutral-800 bg-neutral-900 text-neutral-500 hover:border-neutral-700"
                  }`}
                >
                  Sonnet (fast, ~$0.02)
                </button>
                <button
                  onClick={() => setSynthesisModel("opus")}
                  className={`text-xs px-4 py-2 rounded-lg border transition-colors ${
                    synthesisModel === "opus"
                      ? "border-violet-500 bg-violet-500/10 text-violet-200"
                      : "border-neutral-800 bg-neutral-900 text-neutral-500 hover:border-neutral-700"
                  }`}
                >
                  Opus (deep, ~$0.10)
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* GitHub Integration */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-neutral-300">GitHub Integration</h2>
          <p className="text-xs text-neutral-500">
            Connect a GitHub Personal Access Token to give models read-only access to your codebase during analysis.
          </p>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">GitHub Personal Access Token</label>
            <input
              type="password"
              value={githubPat}
              onChange={(e) => setGithubPat(e.target.value)}
              placeholder="ghp_... or github_pat_..."
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
            />
          </div>

          <div className="text-xs text-neutral-600 space-y-1">
            <p><strong className="text-neutral-500">Classic token:</strong> select <code className="text-neutral-400">repo</code> scope</p>
            <p><strong className="text-neutral-500">Fine-grained token:</strong> select <code className="text-neutral-400">Contents: Read-only</code> for All or Selected repositories</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleValidatePat}
              disabled={!githubPat.trim() || patValidating}
              className={`text-xs px-4 py-2 rounded-lg border transition-colors ${
                patValidating
                  ? "border-neutral-800 bg-neutral-900 text-neutral-600 cursor-wait"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-violet-500 hover:text-violet-300"
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {patValidating ? "Validating..." : "Validate Token"}
            </button>

            {patValidation && (
              <div className={`text-xs ${patValidation.valid ? "text-emerald-400" : "text-red-400"}`}>
                {patValidation.valid ? (
                  <span>
                    Connected as <strong>{patValidation.username}</strong>
                    {patValidation.scopes && patValidation.scopes.length > 0 && (
                      <span className="text-neutral-500 ml-1">({patValidation.scopes.join(", ")})</span>
                    )}
                  </span>
                ) : (
                  <span>
                    {patValidation.errorType === "bad_token" && "Invalid token — check for typos"}
                    {patValidation.errorType === "insufficient_scope" && "Token needs `repo` scope. Create a new token with Contents: Read-only."}
                    {patValidation.errorType === "sso_required" && "This organization requires SSO authorization for your token."}
                    {patValidation.errorType === "rate_limited" && "Rate limited — try again later."}
                    {!patValidation.errorType && patValidation.message}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Cache management */}
          <div className="border-t border-neutral-800 pt-4 mt-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-500">
                Context cache: {cacheEntries} entries (~{(cacheSize / 1024).toFixed(0)}KB)
              </span>
              <button
                onClick={handleClearCache}
                disabled={cacheClearing || cacheEntries === 0}
                className="text-xs text-neutral-600 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {cacheClearing ? "Clearing..." : "Clear Cache"}
              </button>
            </div>
          </div>
        </section>

        {/* Save button */}
        <button
          onClick={saveKeys}
          className="px-4 py-2 rounded-lg bg-violet-600 text-sm font-medium text-white hover:bg-violet-500 transition-colors"
        >
          {saved ? "Saved!" : "Save All Settings"}
        </button>

        {/* Project Profiles */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-neutral-300">Project Profiles</h2>
          <p className="text-xs text-neutral-500">
            Profiles set the default run preset, model mix, synthesis model, budget, and context-pack hint for a project.
          </p>

          <div className="space-y-2">
            {[...BUILT_IN_PROJECT_PROFILES, ...customProfiles].map((profile) => (
              <div key={profile.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-200">{profile.name}</p>
                  <p className="text-xs text-neutral-500 mt-1">{profile.description}</p>
                  <p className="text-[11px] text-neutral-600 mt-2">
                    Preset: {profile.defaultRunPresetId} · Models: {profile.defaultModelPreset} · Synthesis: {profile.defaultSynthesisModel} · Budget: ${profile.defaultMaxCost.toFixed(2)}
                  </p>
                </div>
                {profile.id.startsWith("profile_") && (
                  <button onClick={() => removeProfile(profile.id)} className="text-xs text-red-400/60 hover:text-red-400 transition-colors">
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-dashed border-neutral-700 p-4 space-y-3">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="Project profile name"
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
            />
            <input
              value={profileDescription}
              onChange={(e) => setProfileDescription(e.target.value)}
              placeholder="Short description"
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select value={profileRunPreset} onChange={(e) => setProfileRunPreset(e.target.value)} className="bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500">
                {DEFAULT_RUN_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
              <select value={profileModelPreset} onChange={(e) => setProfileModelPreset(e.target.value as ModelSelectionPreset)} className="bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500">
                <option value="frontier">Frontier</option>
                <option value="diverse">Diverse</option>
                <option value="all">All</option>
                <option value="free">Free</option>
              </select>
              <select value={profileSynthesisModel} onChange={(e) => setProfileSynthesisModel(e.target.value as "sonnet" | "opus")} className="bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500">
                <option value="sonnet">Sonnet synthesis</option>
                <option value="opus">Opus synthesis</option>
              </select>
              <input
                type="number"
                min="0"
                step="0.25"
                value={profileMaxCost}
                onChange={(e) => setProfileMaxCost(Number(e.target.value || "0"))}
                className="bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500"
              />
            </div>
            <input
              value={profileContextName}
              onChange={(e) => setProfileContextName(e.target.value)}
              placeholder="Optional context pack name hint"
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
            />
            <button
              onClick={addProfile}
              disabled={!profileName.trim()}
              className="px-4 py-2 rounded-lg bg-neutral-800 text-sm text-neutral-300 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Add Profile
            </button>
          </div>
        </section>

        {/* Default Prompt Templates */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-neutral-300">Built-in Templates</h2>
          <div className="space-y-2">
            {DEFAULT_TEMPLATES.map((t) => (
              <div
                key={t.id}
                className="rounded-lg border border-neutral-800 bg-neutral-900 p-3"
              >
                <p className="text-sm font-medium text-neutral-200">{t.name}</p>
                <p className="text-xs text-neutral-500 mt-1 line-clamp-2">{t.prompt}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Custom Templates */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-neutral-300">Custom Templates</h2>

          {customTemplates.length > 0 && (
            <div className="space-y-2">
              {customTemplates.map((t) => (
                <div
                  key={t.id}
                  className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 flex items-start justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-200">{t.name}</p>
                    <p className="text-xs text-neutral-500 mt-1 line-clamp-2">{t.prompt}</p>
                  </div>
                  <button
                    onClick={() => removeTemplate(t.id)}
                    className="ml-3 text-xs text-red-400/60 hover:text-red-400 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-dashed border-neutral-700 p-4 space-y-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Template name"
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500"
            />
            <textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              placeholder="Prompt text..."
              rows={3}
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-violet-500 resize-y"
            />
            <button
              onClick={addTemplate}
              disabled={!newName.trim() || !newPrompt.trim()}
              className="px-4 py-2 rounded-lg bg-neutral-800 text-sm text-neutral-300 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Add Template
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
