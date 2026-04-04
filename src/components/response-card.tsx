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

  const borderColor = {
    pending: "border-grey-10",
    streaming: "border-gold/40",
    complete: isComparing ? "border-green" : "border-border",
    error: "border-red-300",
  }[response.status];

  const bgColor = {
    pending: "bg-grey-5",
    streaming: "bg-cream",
    complete: isComparing ? "bg-green-light" : "bg-white",
    error: "bg-red-50",
  }[response.status];

  const dotColor = {
    pending: "bg-grey-20",
    streaming: "bg-gold animate-pulse",
    complete: "bg-green",
    error: "bg-red-400",
  }[response.status];

  return (
    <div className={cn("border p-4 transition-all duration-300", borderColor, bgColor)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1 cursor-pointer"
          onClick={() => response.status === "complete" && setExpanded(!expanded)}>
          <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", dotColor)} />
          <span className="text-sm font-medium text-ink">{response.modelName}</span>
        </div>
        <div className="flex items-center gap-4 text-[10px] tracking-wide text-grey-40">
          {response.timeMs != null && <span>{(response.timeMs / 1000).toFixed(1)}s</span>}
          {response.outputTokens != null && <span>{response.outputTokens} tok</span>}
          {compareMode && response.status === "complete" && onToggleCompare && (
            <button onClick={(e) => { e.stopPropagation(); onToggleCompare(); }}
              className={cn(
                "cta-text px-3 py-1 border transition-colors duration-300",
                isComparing ? "border-green bg-green text-cream" : "border-border text-grey-40 hover:border-green hover:text-green"
              )}>
              {isComparing ? "Selected" : "Compare"}
            </button>
          )}
        </div>
      </div>

      {response.status === "error" && (
        <p className="mt-3 text-xs text-red-500">{response.error}</p>
      )}

      {response.status === "complete" && response.response && (
        <div className="mt-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
          {expanded ? (
            <p className="text-sm text-grey-60 whitespace-pre-wrap leading-relaxed">{response.response}</p>
          ) : (
            <p className="text-sm text-grey-40 line-clamp-2 leading-relaxed">{response.response}</p>
          )}
        </div>
      )}

      {response.status === "pending" && <p className="mt-2 text-[10px] text-grey-20 tracking-wide">Waiting...</p>}
      {response.status === "streaming" && <p className="mt-2 text-[10px] text-gold tracking-wide">Analyzing...</p>}
    </div>
  );
}
