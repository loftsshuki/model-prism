"use client";
import { useCallback, useEffect, useState } from "react";
import { jsonHeaders } from "@/lib/client-api";
import type { DismissalReason, FindingState, TrackedFinding } from "@/lib/finding-tracking";

const field = "w-full min-w-0 border border-border bg-white px-3 py-2 text-sm";
function FindingDecision({ item, runId, refresh }: { item: TrackedFinding; runId: string; refresh: () => Promise<void> }) {
  const [state, setState] = useState(item.state);
  const [reason, setReason] = useState<DismissalReason>(item.dismissalReason ?? "false_positive");
  const [note, setNote] = useState(item.note);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/findings`, { method: "PATCH", headers: jsonHeaders(),
        body: JSON.stringify({ fingerprint: item.fingerprint, state, dismissalReason: state === "dismissed" ? reason : undefined, note }) });
      if (!response.ok) throw new Error("Decision could not be saved. Your changes are still here; try again.");
      await refresh(); setMessage("Saved");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save decision"); }
    finally { setSaving(false); }
  }
  return <article className="border-t border-border py-4 space-y-3">
    <div className="flex flex-wrap gap-2 text-xs"><span>{item.finding.severity.toUpperCase()}</span><span className="text-green">{item.change === "not_reported" ? "Not reported in this review" : item.change === "recurring" ? "Recurring finding" : "New finding"}</span><span>{item.state.replaceAll("_", " ")}</span></div>
    <h3 className="font-medium text-sm">{item.finding.title}</h3>
    <p className="text-sm text-grey-60">{item.finding.recommendation}</p>
    <div className="space-y-1 text-xs break-words">{item.locations.map(location => <p key={`${location.sourceId}:${location.startLine}`}>
      {location.url ? <a className="underline text-green" href={location.url} target="_blank" rel="noopener noreferrer">{location.path}:{location.startLine}{location.endLine !== location.startLine ? `–${location.endLine}` : ""}</a>
        : <span>{location.path}:{location.startLine}{location.endLine !== location.startLine ? `–${location.endLine}` : ""} · supplied source</span>}
    </p>)}{!item.locations.length && <p className="text-grey-50">No unambiguous file location in the supplied sources.</p>}</div>
    <details><summary className="cursor-pointer text-xs text-green">Inspect quoted evidence</summary>{item.finding.evidence.map((evidence, index) => <blockquote key={index} className="mt-2 border-l-2 border-green pl-3 text-xs whitespace-pre-wrap break-words">{evidence.quote}<cite className="block mt-1 text-grey-50 break-all">{evidence.source}</cite></blockquote>)}</details>
    <fieldset disabled={saving} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">Decision<select aria-label={`Decision for ${item.finding.title}`} className={`${field} mt-1`} value={state} onChange={event => { setState(event.target.value as FindingState); setMessage(""); }}><option value="open">Open</option><option value="accepted">Accepted — confirmed issue</option><option value="dismissed">Dismissed</option><option value="fixed">Fixed — verified by me</option></select></label>
        {state === "dismissed" && <label className="text-xs">Dismissal reason<select className={`${field} mt-1`} value={reason} onChange={event => setReason(event.target.value as DismissalReason)}><option value="false_positive">False positive</option><option value="not_actionable">Not actionable</option><option value="duplicate">Duplicate</option><option value="other">Other</option></select></label>}
      </div>
      <label className="block text-xs">Decision note<textarea className={`${field} mt-1`} value={note} onChange={event => setNote(event.target.value)} maxLength={2000} rows={2} placeholder="What did you verify or change?" /></label>
      <button onClick={save} className="min-h-11 border border-green px-3 py-2 text-sm text-green">{saving ? "Saving…" : "Save decision"}</button>
    </fieldset>
    {message && <p role="status" className="text-xs text-green">{message}</p>}
  </article>;
}

export function FindingTracker({ runId, revision }: { runId: string; revision?: number }) {
  const [findings, setFindings] = useState<TrackedFinding[]>([]);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/findings`, { headers: jsonHeaders(), cache: "no-store" });
    if (!response.ok) throw new Error("Finding decisions are available after this review has saved to your private history.");
    const data = await response.json();
    setFindings(data.findings ?? []); setBaseline(data.baselineRunId ?? null); setError("");
  }, [runId]);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { void load().catch(error => { if (mounted) setError(error.message); }).finally(() => { if (mounted) setLoading(false); }); });
    return () => { mounted = false; };
  }, [load, revision]);
  return <section className="border border-border bg-white p-4 sm:p-5 space-y-3" aria-label="Finding decisions">
    <h2 className="font-display text-xl">Track findings</h2>
    <p className="text-xs text-grey-50">Confirm useful findings, dismiss false positives, and mark fixes you have verified. Decisions carry forward when the same title and file evidence recur in this project.</p>
    {baseline && <p className="text-xs text-grey-50">Compared with <a className="underline text-green" href={`/runs/${encodeURIComponent(baseline)}`}>the previous review</a>. A finding missing from this review is not automatically fixed.</p>}
    {loading && <p className="text-sm" role="status">Loading decisions…</p>}
    {error && <p className="text-sm" role="status">{error} <button className="underline text-green" onClick={() => { void load().catch(error => setError(error.message)); }}>Retry</button></p>}
    {!loading && !error && !findings.length && <p className="text-sm">No structured findings to track in this review.</p>}
    {findings.map(item => <FindingDecision key={item.fingerprint} item={item} runId={item.change === "not_reported" ? baseline! : runId} refresh={load} />)}
  </section>;
}
