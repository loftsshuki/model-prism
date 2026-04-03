"use client";

import { useState } from "react";
import { ModelResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ResponseCardProps {
  response: ModelResponse;
}

export function ResponseCard({ response }: ResponseCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColor = {
    pending: "border-neutral-800 bg-neutral-900/50",
    streaming: "border-amber-500/30 bg-amber-500/5",
    complete: "border-emerald-500/30 bg-emerald-500/5",
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
      className={cn(
        "rounded-lg border p-3 transition-all cursor-pointer",
        statusColor
      )}
      onClick={() => response.status === "complete" && setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn("w-1.5 h-1.5 rounded-full", statusDot)} />
          <span className="text-sm font-medium text-neutral-200">
            {response.modelName}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          {response.timeMs && <span>{(response.timeMs / 1000).toFixed(1)}s</span>}
          {response.outputTokens != null && (
            <span>{response.outputTokens} tok</span>
          )}
        </div>
      </div>

      {response.status === "error" && (
        <p className="mt-2 text-xs text-red-400">{response.error}</p>
      )}

      {response.status === "complete" && response.response && (
        <div className="mt-2">
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
