"use client";

import { useState, useEffect, useCallback } from "react";
import { DEFAULT_TEMPLATES, PromptTemplate } from "@/lib/prompts";
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
  const [synthesisModel, setSynthesisModel] = useState("sonnet");
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>([]);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
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
    setSynthesisModel(getStoredKey("synthesis-model") || "sonnet");
    setGithubPat(getStoredKey("github-pat"));
    setCustomTemplates(getCustomTemplates());

    // Load cache stats
    (async () => {
      setCacheSize(await getCacheSize());
      setCacheEntries(await getCacheEntryCount());
    })();
  }, []);

  const saveKeys = () => {
    localStorage.setItem("openrouter-api-key", openrouterKey);
    localStorage.setItem("anthropic-api-key", anthropicKey);
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
