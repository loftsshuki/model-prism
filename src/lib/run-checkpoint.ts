import { z } from "zod";
import type { ModelInfo, ModelResponse, ModelUsage, SynthesisResult } from "./types";
import { jsonHeaders } from "./client-api";
import { SourceDocumentSchema, type SourceDocument } from "./review-policy";
import { DECISION_MODES, type DecisionGateRecord, type DecisionModes } from "./decision-gate";

export interface ReviewInput {
  content: string; prompt: string; context: string; reasoningEffort: string;
  projectKey?: string;
}
export interface RunCheckpoint extends ReviewInput {
  version: 1; id: string; revision: number; createdAt: string; updatedAt: string;
  status: "running" | "synthesizing" | "stopped" | "complete" | "error";
  models: ModelInfo[]; responses: ModelResponse[]; usage: ModelUsage[];
  synthesisModel: string; maxCost: number; maxTokens: number; synthesisMaxTokens: number;
  synthesis?: SynthesisResult; secondPass?: SynthesisResult; error?: string;
  contextMetadata?: string;
  sources?: SourceDocument[];
  background?: { execution: number; state: "queued" | "running" | "stopping" | "stopped" | "complete" | "error"; phase: string };
  adaptive?: { enabled: boolean; initialIds: string[]; escalatedIds: string[]; reasons: string[] };
  projectKey?: string;
  baselineRunId?: string;
  decisionModes?: DecisionModes;
  decisionGates?: DecisionGateRecord[];
}

export function sameReviewInput(a: ReviewInput, b: ReviewInput): boolean {
  return a.content === b.content && a.prompt === b.prompt && a.context === b.context && a.reasoningEffort === b.reasoningEffort
    && (a.projectKey ?? "default") === (b.projectKey ?? "default");
}
export function mergeUsage(records: ModelUsage[]): ModelUsage[] {
  return [...new Map(records.map((record) => [record.requestId, record])).values()];
}
export function checkpointCost(run: Pick<RunCheckpoint, "usage">) {
  return mergeUsage(run.usage).reduce((total, record) => total + record.cost, 0);
}

const usageSchema = z.object({ requestId: z.string().max(200), model: z.string().max(200), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), cost: z.number().finite().nonnegative(), costSource: z.enum(["provider", "estimated", "reserved"]) });
const modelSchema = z.object({ id: z.string().max(200), name: z.string().max(200), family: z.string().max(80), tier: z.enum(["frontier", "strong", "fast", "free"]), contextLength: z.number().positive(), inputCostPer1k: z.number().nonnegative(), outputCostPer1k: z.number().nonnegative() }).passthrough();
const responseSchema = z.object({ model: z.string().max(200), modelName: z.string().max(200), status: z.enum(["pending", "streaming", "complete", "error", "incomplete", "cancelled"]), response: z.string().max(2_000_000).optional(), error: z.string().max(4000).optional(), usage: z.array(usageSchema).max(100).optional() }).passthrough();
export const CheckpointSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^run_[a-zA-Z0-9_-]+$/).max(100), revision: z.number().int().nonnegative(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  content: z.string().max(2_000_000), prompt: z.string().max(100_000), context: z.string().max(4_000_000), reasoningEffort: z.string().max(20),
  status: z.enum(["running", "synthesizing", "stopped", "complete", "error"]), models: z.array(modelSchema).max(100), responses: z.array(responseSchema).max(100), usage: z.array(usageSchema).max(2000),
  synthesisModel: z.string().max(200), maxCost: z.number().finite().positive(), maxTokens: z.number().int().positive().max(131072), synthesisMaxTokens: z.number().int().positive().max(131072),
  synthesis: z.record(z.string(), z.unknown()).optional(), secondPass: z.record(z.string(), z.unknown()).optional(), error: z.string().max(4000).optional(), contextMetadata: z.string().max(20000).optional(),
  sources: z.array(SourceDocumentSchema).max(100).optional(),
  background: z.object({ execution: z.number().int(), state: z.enum(["queued", "running", "stopping", "stopped", "complete", "error"]), phase: z.string().max(300) }).optional(),
  adaptive: z.object({ enabled: z.boolean(), initialIds: z.array(z.string()), escalatedIds: z.array(z.string()), reasons: z.array(z.string()) }).optional(),
  projectKey: z.string().max(200).optional(), baselineRunId: z.string().max(100).optional(),
  decisionModes: z.object({ preReview: z.enum(DECISION_MODES), escalation: z.enum(DECISION_MODES) }).optional(),
  decisionGates: z.array(z.object({
    key: z.enum(["pre-review-depth", "post-synthesis-escalation"]), mode: z.enum(DECISION_MODES),
    phase: z.string().max(100), execution: z.number().int().positive(), evaluatedAt: z.string().datetime(),
    answer: z.record(z.string(), z.unknown()).optional(), selectedProbability: z.number().min(0).max(1).optional(),
    deterministicDecision: z.string().max(200), effectiveDecision: z.string().max(200), action: z.string().max(100),
    latencyMs: z.number().nonnegative().optional(), costUsd: z.number().finite().nonnegative().optional(),
    generationId: z.string().max(200).optional(), error: z.string().max(1000).optional(),
  })).max(200).optional(),
});

function openCheckpoints(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("model-prism-runs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("runs", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveLocalCheckpoint(run: RunCheckpoint) {
  const localOwner = sessionStorage.getItem("model-prism-session-scope") || "guest";
  const db = await openCheckpoints();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("runs", "readwrite");
      transaction.objectStore("runs").put({ ...run, localOwner });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
export async function loadLocalCheckpoint(id?: string): Promise<RunCheckpoint | null> {
  const localOwner = sessionStorage.getItem("model-prism-session-scope") || "guest";
  const db = await openCheckpoints();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("runs").objectStore("runs").getAll();
      request.onsuccess = () => {
        const candidates = (request.result as Array<RunCheckpoint & { localOwner?: string }>).filter((run) => (run.localOwner ?? "guest") === localOwner && (!id || run.id === id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const result = candidates.find((run) => CheckpointSchema.safeParse(run).success);
        resolve(result ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function clearLocalCheckpoints() {
  const db = await openCheckpoints();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("runs", "readwrite");
      transaction.objectStore("runs").clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
export async function saveRemoteCheckpoint(run: RunCheckpoint) {
  const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify(run), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status === 409 ? "A newer saved version exists. Reload it before continuing." : `Cloud save failed (${response.status}). Your local checkpoint can still resume.`);
}

export function checkpointMarkdown(run: RunCheckpoint) {
  const costs = checkpointCost(run).toFixed(4);
  return `# Model Prism review\n\nRun: ${run.id}\n\nCost: $${costs} (includes synthesis, retries, and reserved unknown charges)\n\n## Reviewed input\n\n${run.content}\n\n## Review instructions\n\n${run.prompt}\n\n## Master document\n\n${run.synthesis?.masterDocument ?? "Synthesis pending"}\n\n${run.secondPass ? `## Second pass\n\n${run.secondPass.masterDocument}\n\n` : ""}${run.responses.map((response) => `## ${response.modelName}\n\nModel: ${response.model} · ${response.status}\n\n${response.response ?? response.error ?? "Pending"}`).join("\n\n")}`;
}
