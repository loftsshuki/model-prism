"use client";

import { SynthesisResult } from "@/lib/types";
import { ThemeHeatmap } from "./theme-heatmap";

interface SynthesisViewProps {
  synthesis: SynthesisResult;
}

export function SynthesisView({ synthesis }: SynthesisViewProps) {
  return (
    <div className="border border-green/20 bg-white p-6 lg:p-8 space-y-8">
      <div className="flex items-center gap-3">
        <div className="w-8 h-px bg-green" />
        <h2 className="font-display text-2xl font-bold text-ink">Synthesis</h2>
      </div>

      {synthesis.consensus.length > 0 && (
        <div>
          <span className="overline text-green">Consensus</span>
          <ul className="mt-3 space-y-3">
            {synthesis.consensus.map((c, i) => (
              <li key={i} className="text-sm text-grey-60 leading-relaxed pl-4 border-l-2 border-green/30">
                {c.point}
                <span className="text-[10px] text-grey-30 ml-2 tracking-wide">
                  ({c.supportingModels.length} models, {c.strength})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.uniqueInsights.length > 0 && (
        <div>
          <span className="overline text-gold">Unique Insights</span>
          <ul className="mt-3 space-y-3">
            {synthesis.uniqueInsights.map((u, i) => (
              <li key={i} className="text-sm text-grey-60 leading-relaxed pl-4 border-l-2 border-gold/30">
                {u.insight}
                <span className="text-[10px] text-grey-30 ml-2 tracking-wide">
                  (only {u.model})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.disagreements.length > 0 && (
        <div>
          <span className="overline text-grey-60">Disagreements</span>
          {synthesis.disagreements.map((d, i) => (
            <div key={i} className="mt-3 mb-4">
              <p className="text-sm font-medium text-ink">{d.topic}</p>
              <ul className="mt-2 space-y-1.5 pl-4">
                {d.positions.map((p, j) => (
                  <li key={j} className="text-xs text-grey-50 leading-relaxed">
                    <span className="text-grey-30">[{p.models.join(", ")}]</span>{" "}
                    {p.position}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {synthesis.blindSpots.length > 0 && (
        <div>
          <span className="overline text-grey-40">Blind Spots</span>
          <ul className="mt-3 space-y-2">
            {synthesis.blindSpots.map((b, i) => (
              <li key={i} className="text-sm text-grey-40 leading-relaxed pl-4 border-l-2 border-grey-10">
                {b}
              </li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.themeMatrix && synthesis.themeMatrix.length > 0 && (
        <ThemeHeatmap themeMatrix={synthesis.themeMatrix} />
      )}
    </div>
  );
}
