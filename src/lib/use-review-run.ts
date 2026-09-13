"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { executeReview, type ReviewOptions } from "./review-engine";
import { loadLocalCheckpoint, saveLocalCheckpoint, saveRemoteCheckpoint, type RunCheckpoint } from "./run-checkpoint";

export function useReviewRun() {
  const [run, setRun] = useState<RunCheckpoint | null>(null);
  const [restorable, setRestorable] = useState<RunCheckpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const current = useRef<RunCheckpoint | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const saving = useRef(Promise.resolve());
  const pending = useRef(new Map<string, RunCheckpoint>());
  const persist = useCallback((snapshot: RunCheckpoint) => {
    // Device durability must not wait for a slow/offline cloud save.
    void saveLocalCheckpoint(snapshot).catch(() => setSaveError("Device storage is unavailable. Keep this tab open until cloud save succeeds."));
    pending.current.set(snapshot.id, snapshot);
    // Coalesce queued snapshots while retaining order for each run.
    saving.current = saving.current.then(async () => {
      const latest = pending.current.get(snapshot.id);
      if (!latest) return;
      pending.current.delete(snapshot.id);
      try { await saveRemoteCheckpoint(latest); setSaveError(null); }
      catch (error) { setSaveError(error instanceof Error ? error.message : "Save failed. Retry saving before closing this tab."); }
    });
  }, []);
  useEffect(() => {
    let mounted = true;
    const epoch = generation;
    const id = new URLSearchParams(window.location.search).get("resume") ?? undefined;
    loadLocalCheckpoint(id).then(async (local) => {
      if (id) {
        try {
          const { jsonHeaders, prepareCloudAccess } = await import("./client-api");
          await prepareCloudAccess(sessionStorage.getItem("openrouter-api-key") || localStorage.getItem("openrouter-api-key") || "");
          const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { headers: jsonHeaders() });
          const data = response.ok ? await response.json() : null;
          if (data?.run?.snapshot && (!local || data.run.snapshot.revision > local.revision)) local = data.run.snapshot;
        } catch { /* Local checkpoint remains usable offline. */ }
      }
      if (mounted && local) setRestorable(local);
    }).catch(() => {});
    return () => { mounted = false; controller.current?.abort(); epoch.current++; };
  }, []);
  const restore = useCallback((snapshot: RunCheckpoint) => {
    current.current = snapshot; setRun(snapshot); setRestorable(null);
  }, []);
  const start = useCallback(async (options: Omit<ReviewOptions, "signal" | "onChange" | "previous">) => {
    if (controller.current) return;
    const token = ++generation.current;
    const abort = new AbortController(); controller.current = abort; setBusy(true);
    try {
      await executeReview({ ...options, previous: current.current, signal: abort.signal,
        onChange: (snapshot, checkpoint) => {
          if (token !== generation.current) return;
          current.current = snapshot; setRun(snapshot);
          if (checkpoint) persist(snapshot);
        },
      });
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Unable to start review"); }
    finally { if (token === generation.current) { controller.current = null; setBusy(false); } }
  }, [persist]);
  return { run, busy, restorable, saveError, start, restore, dismissRestore: () => setRestorable(null),
    stop: () => controller.current?.abort(), retrySave: () => { if (current.current) persist(current.current); } };
}
