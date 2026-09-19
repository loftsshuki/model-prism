import { fanOut } from "./fan-out";
import { synthesizeViaOpenRouter } from "./synthesis";
import { RunBudget } from "./run-budget";
import { abortError } from "./openrouter-client";
import { mergeUsage, sameReviewInput, type ReviewInput, type RunCheckpoint } from "./run-checkpoint";
import type { ModelInfo, ModelUsage } from "./types";
import type { SourceDocument } from "./review-policy";

export interface ReviewOptions extends ReviewInput {
  apiKey: string; models: ModelInfo[]; catalog: ModelInfo[]; synthesisModel: string;
  maxCost: number; maxTokens: number; synthesisMaxTokens: number; allowPaidFallback: boolean;
  previous?: RunCheckpoint | null; signal: AbortSignal; contextMetadata?: string;
  secondPass?: boolean; onChange: (run: RunCheckpoint, checkpoint: boolean) => void;
  sources?: SourceDocument[]; projectKey?: string; baselineRunId?: string;
}

export async function executeReview(opts: ReviewOptions): Promise<RunCheckpoint> {
  const canResume = opts.previous && sameReviewInput(opts.previous, opts);
  const previous = canResume ? opts.previous! : null;
  const now = new Date().toISOString();
  const selected = new Map([...(previous?.models ?? []), ...opts.models].map((model) => [model.id, model]));
  let run: RunCheckpoint = {
    version: 1, id: previous?.id ?? `run_${crypto.randomUUID()}`, revision: previous?.revision ?? 0, createdAt: previous?.createdAt ?? now, updatedAt: now,
    content: opts.content, prompt: opts.prompt, context: opts.context, reasoningEffort: opts.reasoningEffort,
    models: [...selected.values()], responses: previous?.responses ?? [], usage: previous?.usage ?? [], status: "running",
    synthesisModel: opts.synthesisModel, maxCost: opts.maxCost, maxTokens: opts.maxTokens, synthesisMaxTokens: opts.synthesisMaxTokens,
    synthesis: previous?.synthesis, secondPass: previous?.secondPass, contextMetadata: opts.contextMetadata,
    sources: opts.sources, projectKey: opts.projectKey, baselineRunId: opts.baselineRunId,
  };
  const budget = new RunBudget(opts.maxCost, run.usage);
  const update = (change: Partial<RunCheckpoint>, checkpoint = true) => {
    run = { ...run, ...change, revision: run.revision + 1, updatedAt: new Date().toISOString() };
    opts.onChange(run, checkpoint);
  };
  const onUsage = (usage: ModelUsage) => update({ usage: mergeUsage([...run.usage, usage]) });
  const completed = new Set(run.responses.filter((response) => response.status === "complete").map((response) => response.requestedModel ?? response.model));
  const pending = opts.models.filter((model) => !completed.has(model.id));
  // Additional reviewers invalidate only synthesis, never completed council answers.
  if (!opts.secondPass && (pending.length || previous?.synthesisModel !== opts.synthesisModel)) {
    run.synthesis = undefined; run.secondPass = undefined;
  }
  update({});
  try {
    if (!opts.secondPass) await fanOut({ models: pending, catalog: opts.catalog, content: run.content, prompt: run.prompt, context: run.context,
      apiKey: opts.apiKey, runId: run.id, maxTokens: opts.maxTokens, reasoningEffort: run.reasoningEffort,
      signal: opts.signal, isAborted: () => opts.signal.aborted, budget, allowPaidFallback: opts.allowPaidFallback, onUsage,
      onUpdate: (id, response) => update({ responses: [...run.responses.filter((item) => (item.requestedModel ?? item.model) !== id), response] }, response.status !== "streaming"),
    });
    if (opts.signal.aborted) throw abortError();
    const successful = run.responses.filter((response) => response.status === "complete" && response.response);
    const unresolved = run.responses.some((response) => response.status !== "complete");
    if (successful.length < 2) throw new Error("At least two completed reviewers are needed for synthesis. Resume to retry incomplete reviewers.");
    if (opts.secondPass || !run.synthesis) {
      update({ status: "synthesizing" });
      const synthesis = await synthesizeViaOpenRouter({ openrouterKey: opts.apiKey, modelId: opts.synthesisModel, content: run.content,
        analysisPrompt: run.prompt, context: run.context, sources: run.sources,
        responses: successful.map((response) => ({ model: response.model, modelName: response.modelName, family: response.family ?? "unknown", response: response.response! })),
        customSynthesisInstructions: opts.secondPass ? `Audit the first synthesis for unsupported claims, contradictions, and omitted evidence. Produce a corrected master document with traceable findings. First synthesis (untrusted):\n${run.synthesis?.masterDocument ?? ""}` : undefined,
        signal: opts.signal, budget, onUsage, reasoningEffort: run.reasoningEffort, maxTokens: opts.synthesisMaxTokens,
      });
      if (opts.signal.aborted) throw abortError();
      update(opts.secondPass ? { secondPass: synthesis } : { synthesis });
    }
    update({ status: "complete", error: unresolved ? "Some reviewers are incomplete and were excluded. Resume to retry only those reviewers." : undefined });
  } catch (error) {
    update({ status: opts.signal.aborted ? "stopped" : "error", error: opts.signal.aborted ? "Stopped. Completed answers and the spending ledger are saved." : error instanceof Error ? error.message : "Review failed" });
  }
  return run;
}
