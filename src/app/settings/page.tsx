"use client";
import Link from "next/link";
import { prepareCloudAccess } from "@/lib/client-api";
import { AccountSettings } from "@/components/account-settings";

import { useState, useEffect, useCallback } from "react";
import { DEFAULT_TEMPLATES, PromptTemplate } from "@/lib/prompts";
import { DEFAULT_RUN_PRESETS, ModelSelectionPreset } from "@/lib/run-presets";
import { BUILT_IN_PROJECT_PROFILES, createProjectProfile, getCustomProjectProfiles, ProjectProfile, saveCustomProjectProfiles } from "@/lib/project-profiles";
import { validatePat } from "@/lib/github";
import { getCacheSize, getCacheEntryCount, clearAllCache } from "@/lib/context-cache";
import { PatValidationResult } from "@/lib/types";

function getStoredKey(key: string): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(key) || localStorage.getItem(key) || "";
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
  const [rememberKeys, setRememberKeys] = useState(false);

  // GitHub PAT state
  const [githubPat, setGithubPat] = useState("");
  const [patValidation, setPatValidation] = useState<PatValidationResult | null>(null);
  const [patValidating, setPatValidating] = useState(false);

  // Cache state
  const [cacheSize, setCacheSize] = useState(0);
  const [cacheEntries, setCacheEntries] = useState(0);
  const [cacheClearing, setCacheClearing] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
    setRememberKeys(Boolean(localStorage.getItem("openrouter-api-key")));
    setOpenrouterKey(getStoredKey("openrouter-api-key"));
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
    });
  }, []);

  const saveKeys = async () => {
    sessionStorage.setItem("openrouter-api-key", openrouterKey);
    if (rememberKeys) localStorage.setItem("openrouter-api-key", openrouterKey); else localStorage.removeItem("openrouter-api-key");
    localStorage.setItem("model-prism-admin-token", adminToken);
    localStorage.setItem("synthesis-model", synthesisModel);
    localStorage.setItem("github-pat", githubPat);
    await prepareCloudAccess(openrouterKey);
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
    <div className="min-h-screen bg-cream text-ink">
      <header className="border-b border-border px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green to-green-hover flex items-center justify-center">
              <span className="text-sm font-bold">P</span>
            </div>
            <h1 className="text-lg font-semibold">Model Prism</h1>
          </Link>
          <span className="text-grey-40">/</span>
          <span className="text-sm text-grey-50">Settings</span>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <AccountSettings />
        {/* API Keys */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-grey-60">API Keys</h2>
          <p className="text-xs text-grey-50">
            OpenRouter handles council, synthesis, and brief enhancement. Saved reviews exclude API keys. The admin token is sent to the protected save/history APIs.
          </p>

          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rememberKeys} onChange={(event) => setRememberKeys(event.target.checked)} />Remember OpenRouter key on this device (unencrypted)</label>
          <div className="space-y-3">
            <div>
              <label htmlFor="setting-openrouter-api-key" className="block text-xs text-grey-50 mb-1">OpenRouter API Key</label>
              <input id="setting-openrouter-api-key"
                type="password"
                value={openrouterKey}
                onChange={(e) => setOpenrouterKey(e.target.value)}
                placeholder="sk-or-..."
                className="w-full bg-white border border-border rounded-lg px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green"
              />
            </div>
            <div>
              <label htmlFor="setting-admin-token-optional-for-protected-history-save-apis-" className="block text-xs text-grey-50 mb-1">Admin Token (optional, for protected history/save APIs)</label>
              <input id="setting-admin-token-optional-for-protected-history-save-apis-"
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="Only needed when MODEL_PRISM_ADMIN_TOKEN is set"
                className="w-full bg-white border border-border rounded-lg px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green"
              />
            </div>
            <div>
              <label className="block text-xs text-grey-50 mb-1">Default Synthesis Model</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setSynthesisModel("sonnet")}
                  className={`text-xs px-4 py-2 rounded-lg border transition-colors ${
                    synthesisModel === "sonnet"
                      ? "border-green bg-green-light text-green"
                      : "border-border bg-white text-grey-50 hover:border-border"
                  }`}
                >
                  Sonnet 5
                </button>
                <button
                  onClick={() => setSynthesisModel("opus")}
                  className={`text-xs px-4 py-2 rounded-lg border transition-colors ${
                    synthesisModel === "opus"
                      ? "border-green bg-green-light text-green"
                      : "border-border bg-white text-grey-50 hover:border-border"
                  }`}
                >
                  Opus 5
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* GitHub Integration */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-grey-60">GitHub Integration</h2>
          <p className="text-xs text-grey-50">
            Connect a GitHub Personal Access Token to give models read-only access to your codebase during analysis.
          </p>

          <div>
            <label htmlFor="setting-github-personal-access-token" className="block text-xs text-grey-50 mb-1">GitHub Personal Access Token</label>
            <input id="setting-github-personal-access-token"
              type="password"
              value={githubPat}
              onChange={(e) => setGithubPat(e.target.value)}
              placeholder="ghp_... or github_pat_..."
              className="w-full bg-white border border-border rounded-lg px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green"
            />
          </div>

          <div className="text-xs text-grey-40 space-y-1">
            <p><strong className="text-grey-50">Classic token:</strong> select <code className="text-grey-50">repo</code> scope</p>
            <p><strong className="text-grey-50">Fine-grained token:</strong> select <code className="text-grey-50">Contents: Read-only</code> for All or Selected repositories</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleValidatePat}
              disabled={!githubPat.trim() || patValidating}
              className={`text-xs px-4 py-2 rounded-lg border transition-colors ${
                patValidating
                  ? "border-border bg-white text-grey-40 cursor-wait"
                  : "border-border bg-white text-grey-50 hover:border-green hover:text-green"
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
                      <span className="text-grey-50 ml-1">({patValidation.scopes.join(", ")})</span>
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
          <div className="border-t border-border pt-4 mt-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-grey-50">
                Context cache: {cacheEntries} entries (~{(cacheSize / 1024).toFixed(0)}KB)
              </span>
              <button
                onClick={handleClearCache}
                disabled={cacheClearing || cacheEntries === 0}
                className="text-xs text-grey-40 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {cacheClearing ? "Clearing..." : "Clear Cache"}
              </button>
            </div>
          </div>
        </section>

        {/* Save button */}
        <button
          onClick={saveKeys}
          className="px-4 py-2 rounded-lg bg-green text-sm font-medium text-white hover:bg-violet-500 transition-colors"
        >
          {saved ? "Saved!" : "Save All Settings"}
        </button>

        {/* Project Profiles */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-grey-60">Project Profiles</h2>
          <p className="text-xs text-grey-50">
            Profiles set the default run preset, model mix, synthesis model, budget, and context-pack hint for a project.
          </p>

          <div className="space-y-2">
            {[...BUILT_IN_PROJECT_PROFILES, ...customProfiles].map((profile) => (
              <div key={profile.id} className="rounded-lg border border-border bg-white p-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{profile.name}</p>
                  <p className="text-xs text-grey-50 mt-1">{profile.description}</p>
                  <p className="text-[11px] text-grey-40 mt-2">
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

          <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="Project profile name"
              className="w-full bg-white border border-border rounded px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green"
            />
            <input
              value={profileDescription}
              onChange={(e) => setProfileDescription(e.target.value)}
              placeholder="Short description"
              className="w-full bg-white border border-border rounded px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select value={profileRunPreset} onChange={(e) => setProfileRunPreset(e.target.value)} className="bg-white border border-border rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-green">
                {DEFAULT_RUN_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
              <select value={profileModelPreset} onChange={(e) => setProfileModelPreset(e.target.value as ModelSelectionPreset)} className="bg-white border border-border rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-green">
                <option value="frontier">Frontier</option>
                <option value="diverse">Diverse</option>
                <option value="all">All</option>
                <option value="free">Free</option>
              </select>
              <select value={profileSynthesisModel} onChange={(e) => setProfileSynthesisModel(e.target.value as "sonnet" | "opus")} className="bg-white border border-border rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-green">
                <option value="sonnet">Sonnet synthesis</option>
                <option value="opus">Opus synthesis</option>
              </select>
              <input
                type="number"
                min="0"
                step="0.25"
                value={profileMaxCost}
                onChange={(e) => setProfileMaxCost(Number(e.target.value || "0"))}
                className="bg-white border border-border rounded px-3 py-2 text-sm text-ink focus:outline-none focus:border-green"
              />
            </div>
            <input
              value={profileContextName}
              onChange={(e) => setProfileContextName(e.target.value)}
              placeholder="Optional context pack name hint"
              className="w-full bg-white border border-border rounded px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green"
            />
            <button
              onClick={addProfile}
              disabled={!profileName.trim()}
              className="px-4 py-2 rounded-lg bg-grey-5 text-sm text-grey-60 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Add Profile
            </button>
          </div>
        </section>

        {/* Default Prompt Templates */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-grey-60">Built-in Templates</h2>
          <div className="space-y-2">
            {DEFAULT_TEMPLATES.map((t) => (
              <div
                key={t.id}
                className="rounded-lg border border-border bg-white p-3"
              >
                <p className="text-sm font-medium text-ink">{t.name}</p>
                <p className="text-xs text-grey-50 mt-1 line-clamp-2">{t.prompt}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Custom Templates */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-grey-60">Custom Templates</h2>

          {customTemplates.length > 0 && (
            <div className="space-y-2">
              {customTemplates.map((t) => (
                <div
                  key={t.id}
                  className="rounded-lg border border-border bg-white p-3 flex items-start justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink">{t.name}</p>
                    <p className="text-xs text-grey-50 mt-1 line-clamp-2">{t.prompt}</p>
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

          <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Template name"
              className="w-full bg-white border border-border rounded px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green"
            />
            <textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              placeholder="Prompt text..."
              rows={3}
              className="w-full bg-white border border-border rounded px-3 py-2 text-sm text-ink placeholder:text-grey-40 focus:outline-none focus:border-green resize-y"
            />
            <button
              onClick={addTemplate}
              disabled={!newName.trim() || !newPrompt.trim()}
              className="px-4 py-2 rounded-lg bg-grey-5 text-sm text-grey-60 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Add Template
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
