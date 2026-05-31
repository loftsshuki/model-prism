"use client";

import { useMemo } from "react";
import { SynthesisResult } from "@/lib/types";
import { compareSyntheses } from "@/lib/synthesis-compare";

export function SynthesisComparisonView({ previous, next }: { previous: SynthesisResult; next: SynthesisResult }) {
  const comparison = useMemo(() => compareSyntheses(previous, next), [previous, next]);

  return (
    <div className="border border-border bg-white p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-px bg-gold" />
          <h2 className="font-display text-xl font-bold text-grey-60">Synthesis Version Compare</h2>
        </div>
        <span className="text-[10px] uppercase tracking-wide text-grey-30">
          risks {comparison.oldRiskCount} → {comparison.newRiskCount}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CompareList title="New risks" items={comparison.addedRisks} tone="gold" empty="No new risks detected." />
        <CompareList title="Removed risks" items={comparison.removedRisks} tone="grey" empty="No removed risks detected." />
        <CompareList title="Changed recommendations" items={comparison.changedRecommendations} tone="green" empty="No major recommendation changes detected." />
      </div>
    </div>
  );
}

function CompareList({ title, items, tone, empty }: { title: string; items: string[]; tone: "gold" | "grey" | "green"; empty: string }) {
  const color = tone === "gold" ? "border-gold/40 text-gold" : tone === "green" ? "border-green/40 text-green" : "border-grey-20 text-grey-40";
  return (
    <div>
      <span className={`overline ${color.split(" ")[1]}`}>{title}</span>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-grey-30 leading-relaxed">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item} className={`text-xs text-grey-60 leading-relaxed pl-3 border-l-2 ${color.split(" ")[0]}`}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
