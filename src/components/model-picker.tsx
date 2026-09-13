"use client";
import { useState } from "react";
import type { ModelInfo } from "@/lib/types";
import type { ModelSelectionPreset } from "@/lib/run-presets";

interface ModelPickerProps {
  models: ModelInfo[]; selected: Set<string>; tooSmall: Set<string>;
  onToggle: (id: string) => void; onClearAll: () => void; onSelectPreset: (preset: ModelSelectionPreset) => void;
}
export function ModelPicker({ models, selected, tooSmall, onToggle, onClearAll, onSelectPreset }: ModelPickerProps) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const matches = models.filter((model) => `${model.name} ${model.id} ${model.family}`.toLowerCase().includes(search.toLowerCase()));
  const visible = showAll || search ? matches : matches.filter((model) => selected.has(model.id));
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">{([ ["diverse", "Balanced · 5"], ["cheap", "Economy · 5"], ["frontier", "Advanced · 5"], ["free", "Free"] ] as const).map(([preset, label]) => <button key={preset} onClick={() => onSelectPreset(preset)} className="min-h-11 border border-border px-3 py-2 text-sm text-green hover:bg-green-light">{label}</button>)}</div>
    <label className="block text-sm">Find a model<input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder="Search name or provider" className="mt-1 w-full border border-border px-3 py-2.5" /></label>
    <div className="flex justify-between gap-2 text-sm"><span>{selected.size} selected · {new Set(models.filter((model) => selected.has(model.id)).map((model) => model.family)).size} families</span><button className="text-green underline" onClick={onClearAll}>Clear</button></div>
    <div className="max-h-80 overflow-y-auto space-y-2">
      {visible.map((model) => <button key={model.id} disabled={tooSmall.has(model.id)} aria-pressed={selected.has(model.id)} onClick={() => onToggle(model.id)} className={`w-full min-w-0 text-left p-3 border text-sm disabled:opacity-50 ${selected.has(model.id) ? "border-green bg-green-light" : "border-border bg-white"}`}>
        <span className="flex justify-between gap-3"><span className="font-medium break-words">{model.name}</span><span aria-hidden="true">{selected.has(model.id) ? "✓" : "+"}</span></span>
        <span className="block text-xs text-grey-50 mt-1">{model.family} · {(model.contextLength / 1000).toLocaleString()}k context · ${Number((model.inputCostPer1k * 1000).toFixed(3))} in / ${Number((model.outputCostPer1k * 1000).toFixed(3))} out per 1M tokens</span>
        {tooSmall.has(model.id) && <span className="block text-xs mt-1">Input plus output budget exceeds context</span>}
      </button>)}
      {!visible.length && <p className="text-sm text-grey-50 p-2">{search ? "No matching text models." : "Choose a roster or browse the catalog."}</p>}
    </div>
    <button onClick={() => setShowAll(!showAll)} aria-expanded={showAll} className="text-sm text-green underline min-h-11">{showAll ? "Show selected models" : `Browse ${models.length} text models`}</button>
    <p className="text-xs text-grey-50">The free catalog currently may have fewer than two independent families. Add a paid reviewer to enable synthesis.</p>
  </div>;
}
