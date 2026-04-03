"use client";

import { useState, useEffect } from "react";
import { DEFAULT_TEMPLATES, PromptTemplate } from "@/lib/prompts";

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

  useEffect(() => {
    setOpenrouterKey(getStoredKey("openrouter-api-key"));
    setAnthropicKey(getStoredKey("anthropic-api-key"));
    setSynthesisModel(getStoredKey("synthesis-model") || "sonnet");
    setCustomTemplates(getCustomTemplates());
  }, []);

  const saveKeys = () => {
    localStorage.setItem("openrouter-api-key", openrouterKey);
    localStorage.setItem("anthropic-api-key", anthropicKey);
    localStorage.setItem("synthesis-model", synthesisModel);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

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
              <label className="block text-xs text-neutral-400 mb-1">Anthropic API Key (for synthesis)</label>
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

          <button
            onClick={saveKeys}
            className="px-4 py-2 rounded-lg bg-violet-600 text-sm font-medium text-white hover:bg-violet-500 transition-colors"
          >
            {saved ? "Saved!" : "Save Keys"}
          </button>
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
