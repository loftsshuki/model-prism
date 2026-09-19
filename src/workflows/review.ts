import { getWorkflowMetadata } from "workflow";
import { failReview, finishReview, planEscalation, prepareReview, recoverInitialCouncil, reviewModel, synthesizeReview } from "../lib/server/review-worker";

export async function backgroundReview(runId: string, execution: number) {
  "use workflow";
  try {
  const plan = await prepareReview(runId, execution, getWorkflowMetadata().workflowRunId);
  if (!plan) return;
  if (plan.secondPass) {
    if (await synthesizeReview(runId, execution, "secondPass")) await finishReview(runId, execution);
    return;
  }
  await Promise.all(plan.initialIds.map(modelId => reviewModel(runId, execution, modelId)));
  const recovery = await recoverInitialCouncil(runId, execution);
  if (recovery.length) await Promise.all(recovery.map(modelId => reviewModel(runId, execution, modelId)));
  if (!await synthesizeReview(runId, execution, "draft")) return;
  const additional = await planEscalation(runId, execution);
  if (additional.length) {
    await Promise.all(additional.map(modelId => reviewModel(runId, execution, modelId)));
    if (!await synthesizeReview(runId, execution, "final")) return;
  }
  await finishReview(runId, execution);
  } catch { await failReview(runId, execution); }
}
