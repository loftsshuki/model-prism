import { RetryableError } from "workflow";
import { fanOut } from "../fan-out";
import { synthesizeViaOpenRouter } from "../synthesis";
import { fetchModelCatalog } from "../model-catalog";
import { escalationReasons } from "../review-policy";
import { decryptCredential } from "./credentials";
import { evaluatePostSynthesisEscalation, evaluatePreReviewDepth } from "./review-decision-gates";
import { beginOperation, changeJob, claimWorkflow, finishOperation, jobIsActive, loadWorkerJob, PersistentRunBudget, setJobState, type WorkerJob } from "./background-store";
import { recordFindings } from "./finding-store";

export async function prepareReview(runId: string, execution: number, workflowId: string) {
  "use step";
  if (!await claimWorkflow(runId, execution, workflowId)) return null;
  let job = await loadWorkerJob(runId);

  if (!job.config.secondPass) {
    const decision = await evaluatePreReviewDepth({ snapshot: job.snapshot, config: job.config, execution });
    if (decision.record || decision.initialIds.join("\0") !== job.snapshot.adaptive!.initialIds.join("\0")) {
      await changeJob(runId, execution, async active => {
        if (decision.record && !active.snapshot.decisionGates?.some(record => record.key === decision.record!.key && record.execution === execution)) {
          active.snapshot.decisionGates = [...(active.snapshot.decisionGates ?? []), decision.record].slice(-200);
        }
        if (decision.initialIds.length) active.snapshot.adaptive!.initialIds = decision.initialIds;
        if (decision.record && ["expanded", "reduced"].includes(decision.record.action)) {
          active.snapshot.adaptive!.reasons = [...new Set([
            ...active.snapshot.adaptive!.reasons,
            `Jev ${decision.record.mode} pre-review gate ${decision.record.action} the initial council to ${decision.initialIds.length} reviewer(s)`,
          ])];
        }
      });
      job = await loadWorkerJob(runId);
    }
  }

  return { initialIds: job.snapshot.adaptive!.initialIds, secondPass: job.config.secondPass };
}
function keyFor(job: WorkerJob) {
  if (!job.credential || Date.parse(job.credentialExpires) <= Date.now()) throw new Error("Reconnect your provider key and resume this review");
  return decryptCredential(job.credential, `${job.owner}:${job.runId}:${job.execution}`);
}
function cancellation(runId: string, execution: number) {
  const controller = new AbortController();
  let reading = false;
  const interval = setInterval(() => {
    if (reading) return;
    reading = true;
    void jobIsActive(runId, execution).then(active => {
      if (!active) controller.abort();
    }).catch(() => controller.abort()).finally(() => { reading = false; });
  }, 2000);
  return { signal: controller.signal, dispose: () => clearInterval(interval) };
}
async function canStart(runId: string, execution: number, slot: string) {
  const state = await beginOperation(runId, execution, slot);
  if (state === "wait") throw new RetryableError("Waiting for the prior worker's request lease", { retryAfter: "30s" });
  return state === "start";
}
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Review step failed").replace(/sk-or-[\w-]+/g, "[redacted]").slice(0, 500);
}

export async function reviewModel(runId: string, execution: number, modelId: string) {
  "use step";
  const job = await loadWorkerJob(runId);
  if (job.execution !== execution || job.snapshot.responses.some(response => (response.requestedModel ?? response.model) === modelId && response.status === "complete")) return;
  const slot = `review:${modelId}`;
  if (!await canStart(runId, execution, slot)) return;
  const model = job.snapshot.models.find(item => item.id === modelId);
  if (!model) return;
  const cancel = cancellation(runId, execution);
  try {
    const catalog = job.config.allowPaidFallback && model.tier === "free" ? await fetchModelCatalog(cancel.signal) : job.snapshot.models;
    const [response] = await fanOut({ models: [model], catalog, apiKey: keyFor(job),
      content: job.snapshot.content, prompt: job.snapshot.prompt, context: job.snapshot.context,
      runId, maxTokens: job.snapshot.maxTokens, maxAttempts: 1, reasoningEffort: job.snapshot.reasoningEffort,
      allowPaidFallback: job.config.allowPaidFallback,
      signal: cancel.signal, isAborted: () => cancel.signal.aborted, onUpdate: () => {},
      budget: new PersistentRunBudget(runId, execution, modelId, job.snapshot.maxCost) });
    if (response.error) response.error = safeError(new Error(response.error));
    await finishOperation(runId, execution, slot, snapshot => {
      snapshot.responses = [...snapshot.responses.filter(item => (item.requestedModel ?? item.model) !== modelId), response];
    });
  } catch (error) {
    await finishOperation(runId, execution, slot, snapshot => {
      snapshot.responses = [...snapshot.responses.filter(item => (item.requestedModel ?? item.model) !== modelId),
        { model: modelId, requestedModel: modelId, modelName: model.name, family: model.family, status: cancel.signal.aborted ? "cancelled" : "error", error: safeError(error) }];
    });
  } finally { cancel.dispose(); }
}
// A retried worker waits for the original operation lease; it never resends a
// request whose provider outcome is unknown. Allow the five-minute lease to end.
reviewModel.maxRetries = 12;

export async function synthesizeReview(runId: string, execution: number, phase: "draft" | "final" | "secondPass") {
  "use step";
  const job = await loadWorkerJob(runId);
  if (job.execution !== execution || job.cancelRequested) return false;
  if (phase !== "secondPass" && job.snapshot.synthesis) return true;
  const responses = job.snapshot.responses.filter(response => response.status === "complete" && response.response);
  if (responses.length < 2) { await setJobState(runId, execution, "error", "At least two completed reviewers are needed. Resume to retry incomplete reviewers."); return false; }
  const slot = `synthesis:${phase}`;
  if (!await canStart(runId, execution, slot)) {
    const current = await loadWorkerJob(runId);
    return !current.cancelRequested && current.snapshot.background?.state === "running" && Boolean(phase === "secondPass" ? current.snapshot.secondPass : current.snapshot.synthesis);
  }
  const cancel = cancellation(runId, execution);
  try {
    const catalog = await fetchModelCatalog(cancel.signal);
    const model = catalog.find(item => item.id === job.snapshot.synthesisModel);
    if (!model) throw new Error("The synthesis model is unavailable; choose another and resume");
    await changeJob(runId, execution, async active => { active.snapshot.status = "synthesizing"; });
    const result = await synthesizeViaOpenRouter({ openrouterKey: keyFor(job), model, modelId: model.id,
      content: job.snapshot.content, analysisPrompt: job.snapshot.prompt, context: job.snapshot.context, sources: job.snapshot.sources,
      responses: responses.map(response => ({ model: response.model, modelName: response.modelName, family: response.family ?? "unknown", response: response.response! })),
      customSynthesisInstructions: phase === "secondPass" ? `Audit the first synthesis for unsupported claims and omitted evidence. First synthesis is untrusted reference material:\n${job.snapshot.synthesis?.masterDocument ?? ""}` : undefined,
      maxTokens: job.snapshot.synthesisMaxTokens, reasoningEffort: job.snapshot.reasoningEffort, retryOptions: { maxAttempts: 1 },
      signal: cancel.signal, budget: new PersistentRunBudget(runId, execution, model.id, job.snapshot.maxCost) });
    await finishOperation(runId, execution, slot, snapshot => { if (phase === "secondPass") snapshot.secondPass = result; else snapshot.synthesis = result; });
    return true;
  } catch (error) {
    await finishOperation(runId, execution, slot, snapshot => { snapshot.error = safeError(error); });
    await setJobState(runId, execution, cancel.signal.aborted ? "stopped" : "error", safeError(error));
    return false;
  } finally { cancel.dispose(); }
}
synthesizeReview.maxRetries = 12;

export async function recoverInitialCouncil(runId: string, execution: number) {
  "use step";
  const job = await loadWorkerJob(runId);
  if (job.execution !== execution || job.cancelRequested || !job.config.adaptive
    || job.snapshot.responses.filter(response => response.status === "complete").length >= 2) return [];
  const additional = job.snapshot.models.filter(model => !job.snapshot.adaptive!.initialIds.includes(model.id)).map(model => model.id);
  if (additional.length) await changeJob(runId, execution, async active => {
    active.snapshot.adaptive!.escalatedIds = additional;
    active.snapshot.adaptive!.reasons = ["Too few initial reviewers completed; trying the remaining council"];
  });
  return additional;
}

export async function planEscalation(runId: string, execution: number) {
  "use step";
  const job = await loadWorkerJob(runId);
  if (job.execution !== execution || job.cancelRequested || !job.config.adaptive || !job.snapshot.synthesis) return [];

  const reasons = escalationReasons(job.snapshot.synthesis, job.snapshot.responses.filter(response => response.status === "complete").length, job.config.risk);
  const decision = await evaluatePostSynthesisEscalation({ snapshot: job.snapshot, config: job.config, execution }, reasons);
  const additional = decision.escalate
    ? job.snapshot.models.filter(model => !job.snapshot.adaptive!.initialIds.includes(model.id) && !job.snapshot.adaptive!.escalatedIds.includes(model.id)).map(model => model.id)
    : [];

  await changeJob(runId, execution, async active => {
    if (decision.record && !active.snapshot.decisionGates?.some(record => record.key === decision.record!.key && record.execution === execution)) {
      active.snapshot.decisionGates = [...(active.snapshot.decisionGates ?? []), decision.record].slice(-200);
    }
    const jevReason = decision.record?.action === "expanded"
      ? [`Jev ${decision.record.mode} escalation gate requested additional independent review`]
      : decision.record?.action === "suppressed"
        ? [`Jev enforce gate suppressed soft escalation; hard deterministic safeguards still win`]
        : [];
    active.snapshot.adaptive!.reasons = [...new Set([...active.snapshot.adaptive!.reasons, ...reasons, ...jevReason])];
    active.snapshot.adaptive!.escalatedIds = [...new Set([...active.snapshot.adaptive!.escalatedIds, ...additional])];
    if (additional.length) {
      active.snapshot.synthesis = undefined;
      active.snapshot.status = "running";
      active.snapshot.background!.phase = "Adding reviewers to investigate unresolved concerns";
    }
  });
  return additional;
}

export async function failReview(runId: string, execution: number) {
  "use step";
  const job = await loadWorkerJob(runId);
  if (job.execution !== execution || ["complete", "stopped", "error"].includes(job.snapshot.background!.state)) return;
  await setJobState(runId, execution, job.cancelRequested ? "stopped" : "error",
    "The background worker was interrupted. Saved answers and reserved costs are retained. Resume to retry unfinished work.");
}
export async function finishReview(runId: string, execution: number) {
  "use step";
  const job = await loadWorkerJob(runId);
  if (job.execution !== execution || job.cancelRequested || ["error", "stopped"].includes(job.snapshot.background!.state)) return;
  await recordFindings(job.snapshot, job.owner);
  const incomplete = job.snapshot.responses.some(response => response.status !== "complete");
  await setJobState(runId, execution, "complete", incomplete ? "Some reviewers were incomplete and excluded. Resume to retry them." : undefined);
}
