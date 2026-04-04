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
  onSelectPreset: (preset: "frontier" | "diverse" | "all" | "free") => void;
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
        <span className="text-xs font-medium text-grey-60">
          {selected.size} selected
        </span>
        <div className="flex gap-1.5">
          <button onClick={onSelectAll} className="cta-text px-2 py-0.5 text-grey-40 hover:text-green transition-colors duration-300">All</button>
          <button onClick={onClearAll} className="cta-text px-2 py-0.5 text-grey-40 hover:text-green transition-colors duration-300">None</button>
        </div>
      </div>

      {/* Presets */}
      <div className="flex gap-1.5 flex-wrap">
        {[
          { key: "frontier" as const, label: "Frontier" },
          { key: "diverse" as const, label: "Diverse" },
          { key: "free" as const, label: "Free Only" },
          { key: "all" as const, label: "All" },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => onSelectPreset(key)}
            className="cta-text px-3 py-1.5 border border-border text-grey-50 hover:border-green hover:text-green transition-colors duration-300">
            {label}
          </button>
        ))}
      </div>

      {/* Model list by tier */}
      <div className="max-h-[280px] overflow-y-auto space-y-4 pr-1">
        {TIERS.map(({ key, label }) => {
          const tierModels = models.filter((m) => m.tier === key);
          if (tierModels.length === 0) return null;
          const availableInTier = tierModels.filter((m) => !tooSmall.has(m.id));
          const allSelected = availableInTier.length > 0 && availableInTier.every((m) => selected.has(m.id));

          return (
            <div key={key} className="space-y-1.5">
              <button onClick={() => onSelectTier(key)}
                className={cn(
                  "overline transition-colors duration-300",
                  allSelected ? "text-green" : "text-grey-30 hover:text-grey-60"
                )}>
                {label} ({availableInTier.length})
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                {tierModels.map((model) => {
                  const disabled = tooSmall.has(model.id);
                  const isSelected = selected.has(model.id);
                  return (
                    <button key={model.id} onClick={() => !disabled && onToggle(model.id)} disabled={disabled}
                      title={disabled ? `Context too small (${model.contextLength.toLocaleString()})` : `${model.name} — ${model.family}`}
                      className={cn(
                        "text-left text-xs px-3 py-2 border transition-all duration-300",
                        disabled
                          ? "border-grey-5 bg-grey-5 text-grey-20 cursor-not-allowed"
                          : isSelected
                            ? "border-green bg-green-light text-green"
                            : "border-border bg-white text-grey-50 hover:border-green/40 hover:text-grey-60"
                      )}>
                      <span className="block truncate font-medium">{model.name}</span>
                      <div className="flex justify-between text-[9px] text-grey-30 mt-0.5">
                        <span>{model.family}</span>
                        <span>{model.inputCostPer1k === 0 && model.outputCostPer1k === 0 ? "free" : `$${model.inputCostPer1k.toFixed(4)}`}</span>
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
