import { jsonHeaders } from "./client-api";
import type { ReviewJob, ReviewJobMode } from "./job-types";
import type { ModelInfo } from "./types";

// Browser-side helpers for the server-side run API (POST /api/jobs etc.). The UI
// wiring ("Run on server") lands separately; these keep the route contract in one place.

export interface EnqueueJobBody {
  content: string;
  prompt: string;
  /** Explicit council; or pass `roster` and let the server resolve it. */
  models?: ModelInfo[];
  roster?: "default" | "cheap";
  mode?: ReviewJobMode;
  context?: string | null;
}

export interface JobResponseStatus {
  model: string;
  modelName: string;
  status: "complete" | "error";
  error: string | null;
  cost: number | null;
  timeMs: number | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: jsonHeaders() });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export function enqueueJob(body: EnqueueJobBody): Promise<{ jobId: string; runId: string }> {
  return request("/api/jobs", { method: "POST", body: JSON.stringify(body) });
}

export function getJob(id: string): Promise<{ job: ReviewJob; responses: JobResponseStatus[] }> {
  return request(`/api/jobs/${encodeURIComponent(id)}`);
}

export function listJobs(): Promise<{ jobs: ReviewJob[] }> {
  return request("/api/jobs");
}

export function cancelJob(id: string): Promise<{ job: ReviewJob }> {
  return request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}
