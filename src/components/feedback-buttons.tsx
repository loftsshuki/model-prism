"use client";

import { useState } from "react";
import { jsonHeaders } from "@/lib/client-api";
import { findingId } from "@/lib/findings";

interface FeedbackButtonsProps {
  claim: string;
  section: "consensus" | "uniqueInsight" | "blindSpot" | "strategicBlindSpot" | "disagreement" | "finding";
  models?: string[];
  runId?: string | null;
}

/**
 * Thumbs up/down on one finding. The vote is keyed by the stable finding id
 * (hash of the normalized claim) and carries the models that raised it, so the
 * leaderboard can weight models by human judgement rather than only by what the
 * synthesizer attributed to them.
 */
export function FeedbackButtons({ claim, section, models = [], runId = null }: FeedbackButtonsProps) {
  const [vote, setVote] = useState<1 | -1 | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const send = async (v: 1 | -1) => {
    if (state === "saving") return;
    setVote(v);
    setState("saving");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ runId, findingId: findingId(claim), claim: claim.slice(0, 2000), section, models, vote: v }),
      });
      setState(res.ok ? "saved" : "failed");
    } catch {
      setState("failed");
    }
  };

  const base = "px-1.5 py-0.5 text-[11px] leading-none border transition-colors duration-200";
  return (
    <span className="inline-flex items-center gap-1 ml-2 align-middle" aria-label="Was this finding useful?">
      <button
        type="button"
        onClick={() => send(1)}
        aria-pressed={vote === 1}
        title="Useful"
        className={`${base} ${vote === 1 ? "border-green bg-green text-cream" : "border-border text-grey-40 hover:border-green hover:text-green"}`}
      >
        👍
      </button>
      <button
        type="button"
        onClick={() => send(-1)}
        aria-pressed={vote === -1}
        title="Not useful or wrong"
        className={`${base} ${vote === -1 ? "border-red-600 bg-red-600 text-cream" : "border-border text-grey-40 hover:border-red-600 hover:text-red-600"}`}
      >
        👎
      </button>
      {state === "failed" && <span className="text-[10px] text-red-600">not saved</span>}
    </span>
  );
}
