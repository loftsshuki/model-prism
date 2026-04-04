"use client";

import { cn } from "@/lib/utils";

interface ThemeHeatmapProps {
  themeMatrix: Array<{
    theme: string;
    scores: Record<string, number>;
  }>;
}

const SCORE_STYLES = [
  "bg-grey-5 text-grey-20",               // 0 — not mentioned
  "bg-gold/10 text-gold",                 // 1 — briefly mentioned
  "bg-green-light text-green",            // 2 — discussed
  "bg-green text-cream",                  // 3 — deeply analyzed
];

const SCORE_LABELS = ["None", "Brief", "Discussed", "Deep"];

export function ThemeHeatmap({ themeMatrix }: ThemeHeatmapProps) {
  if (!themeMatrix || themeMatrix.length === 0) return null;

  const modelNames = [...new Set(themeMatrix.flatMap((t) => Object.keys(t.scores)))];
  const modelAvgs = modelNames.map((name) => {
    const scores = themeMatrix.map((t) => t.scores[name] ?? 0);
    return { name, avg: scores.reduce((a, b) => a + b, 0) / scores.length };
  });
  modelAvgs.sort((a, b) => b.avg - a.avg);
  const sortedModels = modelAvgs.map((m) => m.name);

  const sortedThemes = [...themeMatrix].sort((a, b) => {
    const avgA = Object.values(a.scores).reduce((s, v) => s + v, 0) / Object.values(a.scores).length;
    const avgB = Object.values(b.scores).reduce((s, v) => s + v, 0) / Object.values(b.scores).length;
    return avgB - avgA;
  });

  return (
    <div className="space-y-4">
      <span className="overline text-green">Theme Coverage</span>

      <div className="flex gap-4 text-[9px] text-grey-30 tracking-wide">
        {SCORE_LABELS.map((label, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className={cn("w-4 h-4", SCORE_STYLES[i])} />
            <span>{i}: {label}</span>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left text-[9px] text-grey-30 font-normal pb-2 pr-3 min-w-[120px] tracking-wide uppercase">Theme</th>
              {sortedModels.map((name) => (
                <th key={name} className="text-center text-[9px] text-grey-30 font-normal pb-2 px-1 min-w-[56px] tracking-wide">
                  <span className="block truncate max-w-[65px]" title={name}>{name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedThemes.map((theme) => (
              <tr key={theme.theme}>
                <td className="text-xs text-grey-60 pr-3 py-1.5 align-middle font-medium">{theme.theme}</td>
                {sortedModels.map((modelName) => {
                  const score = Math.min(3, Math.max(0, Math.round(theme.scores[modelName] ?? 0)));
                  return (
                    <td key={modelName} className="px-1 py-1">
                      <div className={cn("w-full h-7 flex items-center justify-center text-[10px] font-medium", SCORE_STYLES[score])}
                        title={`${modelName}: ${SCORE_LABELS[score]} (${score}/3)`}>
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
