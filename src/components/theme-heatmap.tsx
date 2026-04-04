"use client";

import { cn } from "@/lib/utils";

interface ThemeHeatmapProps {
  themeMatrix: Array<{
    theme: string;
    scores: Record<string, number>;
  }>;
}

const SCORE_COLORS = [
  "bg-neutral-800 text-neutral-600",       // 0 — not mentioned
  "bg-amber-500/20 text-amber-300",        // 1 — briefly mentioned
  "bg-emerald-500/20 text-emerald-300",    // 2 — discussed
  "bg-violet-500/30 text-violet-200",      // 3 — deeply analyzed
];

const SCORE_LABELS = ["—", "Brief", "Discussed", "Deep"];

export function ThemeHeatmap({ themeMatrix }: ThemeHeatmapProps) {
  if (!themeMatrix || themeMatrix.length === 0) return null;

  // Get all model names across all themes
  const modelNames = [...new Set(themeMatrix.flatMap((t) => Object.keys(t.scores)))];

  // Calculate average score per model (for sorting)
  const modelAvgs = modelNames.map((name) => {
    const scores = themeMatrix.map((t) => t.scores[name] ?? 0);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { name, avg };
  });
  modelAvgs.sort((a, b) => b.avg - a.avg);
  const sortedModels = modelAvgs.map((m) => m.name);

  // Calculate average score per theme (for sorting)
  const sortedThemes = [...themeMatrix].sort((a, b) => {
    const avgA = Object.values(a.scores).reduce((s, v) => s + v, 0) / Object.values(a.scores).length;
    const avgB = Object.values(b.scores).reduce((s, v) => s + v, 0) / Object.values(b.scores).length;
    return avgB - avgA;
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-neutral-300">Theme Coverage</h3>

      {/* Legend */}
      <div className="flex gap-3 text-[10px] text-neutral-500">
        {SCORE_LABELS.map((label, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className={cn("w-3 h-3 rounded-sm", SCORE_COLORS[i])} />
            <span>{i}: {label}</span>
          </div>
        ))}
      </div>

      {/* Heatmap grid */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left text-[10px] text-neutral-500 font-normal pb-2 pr-3 min-w-[120px]">
                Theme
              </th>
              {sortedModels.map((name) => (
                <th
                  key={name}
                  className="text-center text-[10px] text-neutral-500 font-normal pb-2 px-1 min-w-[60px]"
                >
                  <span className="block truncate max-w-[70px]" title={name}>
                    {name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedThemes.map((theme) => (
              <tr key={theme.theme}>
                <td className="text-xs text-neutral-300 pr-3 py-1 align-middle">
                  {theme.theme}
                </td>
                {sortedModels.map((modelName) => {
                  const score = Math.min(3, Math.max(0, Math.round(theme.scores[modelName] ?? 0)));
                  return (
                    <td key={modelName} className="px-1 py-1">
                      <div
                        className={cn(
                          "w-full h-7 rounded-sm flex items-center justify-center text-[10px] font-medium transition-colors",
                          SCORE_COLORS[score]
                        )}
                        title={`${modelName}: ${SCORE_LABELS[score]} (${score}/3)`}
                      >
                        {score}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
