"use client";

import { ModelResponse } from "@/lib/types";

interface CompareViewProps {
  responses: ModelResponse[];
  onClose: () => void;
}

export function CompareView({ responses, onClose }: CompareViewProps) {
  return (
    <div className="fixed inset-0 z-50 bg-ink/80 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between px-8 py-5 bg-green text-cream">
        <div className="flex items-center gap-3">
          <div className="w-6 h-px bg-cream/40" />
          <h2 className="overline text-cream/80">Comparing {responses.length} Responses</h2>
        </div>
        <button onClick={onClose}
          className="cta-text text-cream/60 hover:text-cream transition-colors duration-300 px-4 py-2 border border-cream/20 hover:border-cream/40">
          Close
        </button>
      </div>
      <div className="flex-1 overflow-hidden flex bg-cream">
        {responses.map((r) => (
          <div key={r.model} className="flex-1 min-w-0 border-r border-border last:border-r-0 flex flex-col">
            <div className="px-5 py-4 border-b border-border bg-white">
              <p className="text-sm font-medium text-ink truncate">{r.modelName}</p>
              <div className="flex gap-4 text-[10px] text-grey-30 mt-1 tracking-wide">
                {r.timeMs && <span>{(r.timeMs / 1000).toFixed(1)}s</span>}
                {r.outputTokens != null && <span>{r.outputTokens} tok</span>}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <p className="text-sm text-grey-60 whitespace-pre-wrap leading-relaxed">{r.response}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
