"use client";

import { useState } from "react";
import { SynthesisResult } from "@/lib/types";
import { ThemeHeatmap } from "./theme-heatmap";

interface SynthesisViewProps {
  synthesis: SynthesisResult;
}

export function SynthesisView({ synthesis }: SynthesisViewProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  return (
    <div className="space-y-6">
      {/* Master Document — the main event */}
      {synthesis.masterDocument && (
        <div className="border border-green bg-white p-6 lg:p-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-px bg-green" />
              <h2 className="font-display text-2xl font-bold text-ink">Master Synthesis</h2>
            </div>
            <span className="overline text-grey-30">All models distilled</span>
          </div>
          <div
            className="prose prose-sm max-w-none text-grey-60 leading-relaxed
              [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-ink [&_h2]:mt-6 [&_h2]:mb-3
              [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-ink [&_h3]:mt-5 [&_h3]:mb-2
              [&_strong]:text-ink [&_strong]:font-semibold
              [&_ul]:space-y-1.5 [&_li]:text-sm
              [&_p]:text-sm [&_p]:mb-3
              [&_ol]:space-y-1.5 [&_ol>li]:text-sm"
            dangerouslySetInnerHTML={{
              __html: synthesis.masterDocument
                .replace(/^### (.*$)/gm, '<h3>$1</h3>')
                .replace(/^## (.*$)/gm, '<h2>$1</h2>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/^\- (.*$)/gm, '<li>$1</li>')
                .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
                .replace(/^\d+\. (.*$)/gm, '<li>$1</li>')
                .replace(/\n\n/g, '</p><p>')
                .replace(/^(?!<[hulo])/gm, (line) => line ? `<p>${line}` : '')
            }}
          />
        </div>
      )}

      {/* Toggle for structured breakdown */}
      <button
        onClick={() => setShowBreakdown(!showBreakdown)}
        className="cta-text text-grey-40 hover:text-green transition-colors duration-300 flex items-center gap-2"
      >
        <span>{showBreakdown ? "Hide" : "Show"} Detailed Breakdown</span>
        <span className="text-[10px]">(consensus, unique insights, disagreements, heatmap)</span>
      </button>

      {showBreakdown && (
        <div className="border border-border bg-white p-6 lg:p-8 space-y-8">
          <div className="flex items-center gap-3">
            <div className="w-8 h-px bg-grey-20" />
            <h2 className="font-display text-xl font-bold text-grey-60">Structured Breakdown</h2>
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
      )}
    </div>
  );
}
