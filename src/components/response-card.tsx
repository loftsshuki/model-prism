"use client";
import { useState } from "react";
import type { ModelResponse } from "@/lib/types";
import { Markdown } from "./markdown";

export function ResponseCard({ response, compareMode = false, isComparing = false, onToggleCompare }: { response: ModelResponse; compareMode?: boolean; isComparing?: boolean; onToggleCompare?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <article className={`border p-4 min-w-0 ${response.status === "complete" ? "border-border bg-white" : "border-gold/50 bg-cream"}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <button className="text-left min-w-0 min-h-11" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span className="block text-sm font-medium break-words">{response.modelName}</span><span className="text-xs text-grey-50">{response.status} · {response.timeMs !== undefined ? `${(response.timeMs / 1000).toFixed(1)}s · ` : ""}${(response.cost ?? 0).toFixed(4)} {response.costSource === "reserved" ? "reserved" : response.costSource === "estimated" ? "estimated" : ""}</span></button>
      {compareMode && response.status === "complete" && onToggleCompare && <button onClick={onToggleCompare} aria-pressed={isComparing} className={`border min-h-11 px-3 py-2 text-sm ${isComparing ? "bg-green text-cream" : "text-green"}`}>{isComparing ? "Selected" : "Compare"}</button>}
    </div>
    {response.fallbackFrom && <p className="text-xs mt-2 break-all">Replacement for {response.fallbackFrom}. Answered by {response.model}.</p>}
    {response.error && <p className="mt-3 text-sm text-red-800">{response.error}</p>}
    {response.response && <div className="mt-3 text-sm text-grey-60 leading-relaxed break-words">{expanded ? <Markdown>{response.response}</Markdown> : <p className={response.status === "streaming" ? "line-clamp-6 whitespace-pre-wrap" : "line-clamp-2"}>{response.response}</p>}</div>}
    {!response.response && response.status === "streaming" && <p className="mt-2 text-sm text-grey-50">Thinking… answer will appear as it arrives.</p>}
  </article>;
}
