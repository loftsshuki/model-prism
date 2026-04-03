"use client";

import { ModelInfo } from "@/lib/types";
import { TIERS } from "@/lib/model-registry";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  models: ModelInfo[];
  selected: Set<string>;
  tooSmall: Set<string>;
  onToggle: (modelId: string) => void;
  onSelectTier: (tier: ModelInfo["tier"]) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onSelectPreset: (preset: "frontier" | "diverse" | "all") => void;
}

export function ModelPicker({
  models,
  selected,
  tooSmall,
  onToggle,
  onSelectTier,
  onSelectAll,
  onClearAll,
  onSelectPreset,
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

      {/* Presets */}
      <div className="flex gap-1.5">
        <button
          onClick={() => onSelectPreset("frontier")}
          className="text-[10px] px-2 py-1 rounded bg-violet-500/10 border border-violet-500/20 text-violet-300 hover:bg-violet-500/20 transition-colors"
        >
          All Frontier
        </button>
        <button
          onClick={() => onSelectPreset("diverse")}
          className="text-[10px] px-2 py-1 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300 hover:bg-blue-500/20 transition-colors"
        >
          Diverse Sweep
        </button>
        <button
          onClick={() => onSelectPreset("all")}
          className="text-[10px] px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
        >
          Full Spread
        </button>
      </div>

      {/* Model list by tier */}
      <div className="max-h-[320px] overflow-y-auto space-y-3 pr-1">
        {TIERS.map(({ key, label }) => {
          const tierModels = models.filter((m) => m.tier === key);
          if (tierModels.length === 0) return null;

          const availableInTier = tierModels.filter((m) => !tooSmall.has(m.id));
          const allSelected = availableInTier.length > 0 && availableInTier.every((m) => selected.has(m.id));

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
                {label} ({availableInTier.length})
              </button>
              <div className="grid grid-cols-2 gap-1">
                {tierModels.map((model) => {
                  const disabled = tooSmall.has(model.id);
                  const isSelected = selected.has(model.id);

                  return (
                    <button
                      key={model.id}
                      onClick={() => !disabled && onToggle(model.id)}
                      disabled={disabled}
                      title={
                        disabled
                          ? `Context too small (${model.contextLength.toLocaleString()} tokens)`
                          : `${model.name} — ${model.family} — ${model.contextLength.toLocaleString()} ctx`
                      }
                      className={cn(
                        "text-left text-xs px-2.5 py-1.5 rounded-md border transition-all",
                        disabled
                          ? "border-neutral-900 bg-neutral-950 text-neutral-700 cursor-not-allowed opacity-50"
                          : isSelected
                            ? "border-violet-500/50 bg-violet-500/10 text-violet-200"
                            : "border-neutral-800 bg-neutral-900 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
                      )}
                    >
                      <span className="block truncate">{model.name}</span>
                      <div className="flex justify-between text-[10px] text-neutral-600 mt-0.5">
                        <span>{model.family}</span>
                        <span>${(model.inputCostPer1k * 1).toFixed(4)}/1k</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
