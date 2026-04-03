"use client";

import { SynthesisResult } from "@/lib/types";

interface SynthesisViewProps {
  synthesis: SynthesisResult;
}

export function SynthesisView({ synthesis }: SynthesisViewProps) {
  return (
    <div className="space-y-6 rounded-xl border border-violet-500/20 bg-violet-500/5 p-5">
      <h2 className="text-lg font-semibold text-violet-200">Synthesis</h2>

      {synthesis.consensus.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-emerald-300 mb-2">
            Consensus
          </h3>
          <ul className="space-y-2">
            {synthesis.consensus.map((c, i) => (
              <li key={i} className="text-sm text-neutral-300">
                <span className="text-emerald-400 mr-1.5">+</span>
                {c.point}
                <span className="text-xs text-neutral-500 ml-2">
                  ({c.supportingModels.length} models, {c.strength})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.uniqueInsights.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-amber-300 mb-2">
            Unique Insights
          </h3>
          <ul className="space-y-2">
            {synthesis.uniqueInsights.map((u, i) => (
              <li key={i} className="text-sm text-neutral-300">
                <span className="text-amber-400 mr-1.5">*</span>
                {u.insight}
                <span className="text-xs text-neutral-500 ml-2">
                  (only {u.model})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {synthesis.disagreements.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-red-300 mb-2">
            Disagreements
          </h3>
          {synthesis.disagreements.map((d, i) => (
            <div key={i} className="mb-3">
              <p className="text-sm font-medium text-neutral-200">{d.topic}</p>
              <ul className="mt-1 space-y-1 pl-3">
                {d.positions.map((p, j) => (
                  <li key={j} className="text-xs text-neutral-400">
                    <span className="text-neutral-500">
                      [{p.models.join(", ")}]
                    </span>{" "}
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
          <h3 className="text-sm font-semibold text-neutral-400 mb-2">
            Blind Spots
          </h3>
          <ul className="space-y-1">
            {synthesis.blindSpots.map((b, i) => (
              <li key={i} className="text-sm text-neutral-500">
                <span className="mr-1.5">?</span>
                {b}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
