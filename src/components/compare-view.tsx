"use client";

import { ModelResponse } from "@/lib/types";

interface CompareViewProps {
  responses: ModelResponse[];
  onClose: () => void;
}

export function CompareView({ responses, onClose }: CompareViewProps) {
  return (
    <div className="fixed inset-0 z-50 bg-neutral-950/90 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">
          Comparing {responses.length} responses
        </h2>
        <button
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700"
        >
          Close
        </button>
      </div>
      <div className="flex-1 overflow-hidden flex">
        {responses.map((r) => (
          <div
            key={r.model}
            className="flex-1 min-w-0 border-r border-neutral-800 last:border-r-0 flex flex-col"
          >
            <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900">
              <p className="text-sm font-medium text-neutral-200 truncate">
                {r.modelName}
              </p>
              <div className="flex gap-3 text-[10px] text-neutral-500 mt-1">
                {r.timeMs && <span>{(r.timeMs / 1000).toFixed(1)}s</span>}
                {r.outputTokens != null && <span>{r.outputTokens} tok</span>}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-sm text-neutral-300 whitespace-pre-wrap leading-relaxed">
                {r.response}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
