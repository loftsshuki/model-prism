"use client";

import { useState } from "react";
import { ModelResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ResponseCardProps {
  response: ModelResponse;
  compareMode?: boolean;
  isComparing?: boolean;
  onToggleCompare?: () => void;
}

export function ResponseCard({
  response,
  compareMode = false,
  isComparing = false,
  onToggleCompare,
}: ResponseCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColor = {
    pending: "border-neutral-800 bg-neutral-900/50",
    streaming: "border-amber-500/30 bg-amber-500/5",
    complete: isComparing
      ? "border-violet-500/50 bg-violet-500/10"
      : "border-emerald-500/30 bg-emerald-500/5",
    error: "border-red-500/30 bg-red-500/5",
  }[response.status];

  const statusDot = {
    pending: "bg-neutral-600",
    streaming: "bg-amber-400 animate-pulse",
    complete: "bg-emerald-400",
    error: "bg-red-400",
  }[response.status];

  return (
    <div
      className={cn("rounded-lg border p-3 transition-all", statusColor)}
    >
      <div className="flex items-center justify-between">
        <div
          className="flex items-center gap-2 flex-1 cursor-pointer"
          onClick={() => response.status === "complete" && setExpanded(!expanded)}
        >
          <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusDot)} />
          <span className="text-sm font-medium text-neutral-200">
            {response.modelName}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          {response.timeMs != null && <span>{(response.timeMs / 1000).toFixed(1)}s</span>}
          {response.outputTokens != null && <span>{response.outputTokens} tok</span>}
          {compareMode && response.status === "complete" && onToggleCompare && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleCompare();
              }}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] transition-colors",
                isComparing
                  ? "bg-violet-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
              )}
            >
              {isComparing ? "Comparing" : "Compare"}
            </button>
          )}
        </div>
      </div>

      {response.status === "error" && (
        <p className="mt-2 text-xs text-red-400">{response.error}</p>
      )}

      {response.status === "complete" && response.response && (
        <div
          className="mt-2 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <p className="text-sm text-neutral-300 whitespace-pre-wrap leading-relaxed">
              {response.response}
            </p>
          ) : (
            <p className="text-sm text-neutral-400 line-clamp-2">
              {response.response}
            </p>
          )}
        </div>
      )}

      {response.status === "pending" && (
        <p className="mt-2 text-xs text-neutral-600">Waiting...</p>
      )}
      {response.status === "streaming" && (
        <p className="mt-2 text-xs text-amber-400/70">Running...</p>
      )}
    </div>
  );
}
