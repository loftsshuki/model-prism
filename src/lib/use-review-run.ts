"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { executeReview, type ReviewOptions } from "./review-engine";
import { loadLocalCheckpoint, OwnerMismatchError, sameReviewInput, saveLocalCheckpoint, saveRemoteCheckpoint, type RunCheckpoint } from "./run-checkpoint";
import { jsonHeaders, prepareCloudAccess } from "./client-api";
import type { DecisionModes } from "./decision-gate";

type StartOptions = Omit<ReviewOptions, "signal" | "onChange" | "previous"> & { background?: boolean; adaptive?: boolean; risk?: "standard" | "high"; decisionModes?: DecisionModes };
const active = (run: RunCheckpoint) => !!run.background && ["queued", "running", "stopping"].includes(run.background.state);

export function useReviewRun() {
  const [run, setRun] = useState<RunCheckpoint | null>(null);
  const [restorable, setRestorable] = useState<RunCheckpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The newest revision the server has confirmed. Views that read server state
  // (finding tracking) wait for it, instead of racing the final save.
  const [saved, setSaved] = useState<{ id: string; revision: number } | null>(null);
  const current = useRef<RunCheckpoint | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const watching = useRef(0);
  const mounted = useRef(true);
  const starting = useRef(false);
  const saving = useRef(Promise.resolve());
  const pending = useRef(new Map<string, RunCheckpoint>());
  // Run ids the server says belong to another key/account; the next resume forks them.
  const foreignRuns = useRef(new Set<string>());
  const lastLocalSave = useRef(0);
  const publish = useCallback((snapshot: RunCheckpoint, force = false) => {
    if (!mounted.current) return;
    current.current = snapshot; setRun(snapshot);
    // Streaming emits an update per token; writing the whole checkpoint (content,
    // context, sources) to IndexedDB each time stalls large runs. Checkpoints
    // (persist) always save; streaming snapshots save at most once a second.
    const now = Date.now();
    if (force || now - lastLocalSave.current >= 1000) {
      lastLocalSave.current = now;
      void saveLocalCheckpoint(snapshot).catch(() => {});
    }
  }, []);
  const persist = useCallback((snapshot: RunCheckpoint) => {
    lastLocalSave.current = Date.now();
    void saveLocalCheckpoint(snapshot).catch(() => { if (mounted.current) setSaveError("Device storage is unavailable. Keep this tab open until cloud save succeeds."); });
    if (snapshot.background) return;
    pending.current.set(snapshot.id, snapshot);
    // Saves keep running after the page unmounts: the final "stopped" checkpoint and
    // its reserved charges must reach the server even when the user navigated away.
    saving.current = saving.current.then(async () => {
      const latest = pending.current.get(snapshot.id);
      if (!latest) return;
      pending.current.delete(snapshot.id);
      try { await saveRemoteCheckpoint(latest); if (mounted.current) { setSaveError(null); setSaved({ id: latest.id, revision: latest.revision }); } }
      catch (error) {
        if (error instanceof OwnerMismatchError) foreignRuns.current.add(latest.id);
        if (mounted.current) setSaveError(error instanceof Error ? error.message : "Save failed. Retry before closing this tab.");
      }
    });
  }, []);
  const watch = useCallback(async (id: string) => {
    const epoch = ++watching.current;
    let failures = 0;
    while (mounted.current && epoch === watching.current) {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { headers: jsonHeaders(), cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(response.status === 404 ? "Review is not accessible with your current credentials" : "Unable to refresh review status");
        const data = await response.json();
        if (!data.run?.snapshot) throw new Error("The saved review is unavailable");
        if (!mounted.current || epoch !== watching.current) return;
        const snapshot = data.run.snapshot as RunCheckpoint;
        publish(snapshot); setBusy(active(snapshot)); setSaveError(null); failures = 0;
        if (!active(snapshot)) return;
      } catch (error) {
        if (!mounted.current || epoch !== watching.current) return;
        failures++;
        setSaveError(`${error instanceof Error ? error.message : "Connection interrupted"}. The server keeps the review and its budget. Reconnecting…`);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1500 * 2 ** failures, 15000)));
    }
  }, [publish]);
  useEffect(() => {
    mounted.current = true;
    const observer = watching;
    const id = new URLSearchParams(window.location.search).get("resume") ?? undefined;
    void loadLocalCheckpoint(id).then(async local => {
      await prepareCloudAccess(sessionStorage.getItem("openrouter-api-key") || localStorage.getItem("openrouter-api-key") || "");
      const target = id ?? local?.id;
      if (target) try {
        const response = await fetch(`/api/runs/${encodeURIComponent(target)}`, { headers: jsonHeaders(), signal: AbortSignal.timeout(10000) });
        const data = response.ok ? await response.json() : null;
        if (data?.run?.snapshot && (!local || data.run.snapshot.revision >= local.revision)) local = data.run.snapshot;
      } catch { /* The local checkpoint still shows saved results offline. */ }
      if (mounted.current && local) setRestorable(local);
    }).catch(() => {});
    return () => {
      mounted.current = false;
      // Abort first and leave the generation alone: the engine's final "stopped"
      // snapshot (with reserved charges) still flows through onChange to persist.
      controller.current?.abort(); observer.current++;
    };
  }, []);
  // A browser run lives in this tab. Leaving the page (reload, close, or an in-app
  // link) aborts it, so ask first. Background runs continue on the server.
  const browserRunActive = busy && !run?.background;
  useEffect(() => {
    if (!browserRunActive) return;
    const message = "A review is running in this tab. Leaving stops it; completed answers and charges are saved.";
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = message; };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.origin !== window.location.origin) return;
      if (anchor.pathname === window.location.pathname && anchor.search === window.location.search) return;
      if (!window.confirm(message)) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", onClick, true); };
  }, [browserRunActive]);
  const restore = useCallback((snapshot: RunCheckpoint) => {
    // A restored run comes from a saved copy, so server-backed views may load it now.
    publish(snapshot, true); setRestorable(null); setSaved({ id: snapshot.id, revision: snapshot.revision });
    if (snapshot.background) { setBusy(active(snapshot)); void watch(snapshot.id); }
  }, [publish, watch]);
  const start = useCallback(async (options: StartOptions) => {
    if (controller.current || starting.current || (current.current && active(current.current))) return;
    starting.current = true;
    const token = ++generation.current;
    setBusy(true); setSaveError(null);
    try {
      if (options.background || current.current?.background && sameReviewInput(current.current, options)) {
        const previous = current.current && sameReviewInput(current.current, options) ? current.current : null;
        const id = previous?.id ?? `run_${crypto.randomUUID()}`;
        const response = await fetch("/api/reviews", { method: "POST", headers: jsonHeaders(), signal: AbortSignal.timeout(55000),
          body: JSON.stringify({ submissionId: crypto.randomUUID(), apiKey: options.apiKey, review: {
            id, content: options.content, prompt: options.prompt, context: options.context, reasoningEffort: options.reasoningEffort,
            modelIds: options.models.map(model => model.id), synthesisModel: options.synthesisModel,
            maxCost: options.maxCost, maxTokens: options.maxTokens, synthesisMaxTokens: options.synthesisMaxTokens,
            adaptive: options.adaptive ?? false, risk: options.risk ?? "standard", decisionModes: options.decisionModes, allowPaidFallback: options.allowPaidFallback,
            secondPass: options.secondPass ?? false, contextMetadata: options.contextMetadata,
            sources: previous?.background ? previous.sources : options.sources ?? [],
            projectKey: previous?.background ? previous.projectKey : options.projectKey ?? "default",
            baselineRunId: previous?.background ? previous.baselineRunId : options.baselineRunId,
          } }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `Unable to start review (${response.status})`);
        if (data.snapshot) publish(data.snapshot);
        window.history.replaceState(null, "", `/?resume=${encodeURIComponent(data.id)}`);
        void watch(data.id);
      } else {
        const abort = new AbortController(); controller.current = abort;
        // Continue a run saved under another key as a new saved run: same answers and
        // usage (nothing re-billed), new id the current owner can save.
        const prior = current.current;
        const previous = prior && foreignRuns.current.has(prior.id)
          ? { ...prior, id: `run_${crypto.randomUUID()}`, revision: 0, createdAt: new Date().toISOString() }
          : prior;
        await executeReview({ ...options, previous, signal: abort.signal,
          onChange: (snapshot, checkpoint) => {
            if (token !== generation.current) return;
            publish(snapshot, checkpoint); if (checkpoint) persist(snapshot);
          } });
        if (token === generation.current) setBusy(false);
      }
    } catch (error) {
      if (mounted.current) { setSaveError(error instanceof Error ? error.message : "Unable to start review"); setBusy(false); }
    } finally { starting.current = false; if (token === generation.current) controller.current = null; }
  }, [persist, publish, watch]);
  const stop = useCallback(async () => {
    const snapshot = current.current;
    if (!snapshot?.background) { controller.current?.abort(); return; }
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(snapshot.id)}/stop`, { method: "POST", headers: jsonHeaders(), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("Stop could not be confirmed. Reconnect and try again; the spending limit still applies.");
      void watch(snapshot.id);
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Unable to stop review"); }
  }, [watch]);
  const savedRevision = run && saved?.id === run.id ? saved.revision : -1;
  return { run, busy, restorable, saveError, savedRevision, start, restore, stop, dismissRestore: () => setRestorable(null),
    retrySave: () => { if (current.current?.background) void watch(current.current.id); else if (current.current) persist(current.current); } };
}
