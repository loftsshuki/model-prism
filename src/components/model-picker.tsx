"use client";

import { ModelInfo } from "@/lib/types";
import { MODELS, TIERS } from "@/lib/model-registry";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  selected: Set<string>;
  onToggle: (modelId: string) => void;
  onSelectTier: (tier: ModelInfo["tier"]) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}

export function ModelPicker({
  selected,
  onToggle,
  onSelectTier,
  onSelectAll,
  onClearAll,
}: ModelPickerProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-neutral-300">
          Models ({selected.size} selected)
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={onSelectAll}
            className="text-xs px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            All
          </button>
          <button
            onClick={onClearAll}
            className="text-xs px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            None
          </button>
        </div>
      </div>

      {TIERS.map(({ key, label }) => {
        const tierModels = MODELS.filter((m) => m.tier === key);
        const allSelected = tierModels.every((m) => selected.has(m.id));

        return (
          <div key={key} className="space-y-1.5">
            <button
              onClick={() => onSelectTier(key)}
              className={cn(
                "text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded transition-colors",
                allSelected
                  ? "text-violet-300 bg-violet-500/20"
                  : "text-neutral-500 hover:text-neutral-300"
              )}
            >
              {label}
            </button>
            <div className="grid grid-cols-2 gap-1">
              {tierModels.map((model) => (
                <button
                  key={model.id}
                  onClick={() => onToggle(model.id)}
                  className={cn(
                    "text-left text-xs px-2.5 py-1.5 rounded-md border transition-all",
                    selected.has(model.id)
                      ? "border-violet-500/50 bg-violet-500/10 text-violet-200"
                      : "border-neutral-800 bg-neutral-900 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
                  )}
                >
                  <span className="block truncate">{model.name}</span>
                  <span className="block text-[10px] text-neutral-600">
                    {model.family}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
