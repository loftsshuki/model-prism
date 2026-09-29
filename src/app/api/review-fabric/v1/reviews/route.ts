import { NextRequest } from "next/server";
import { submitReview } from "@/lib/mcp/review-tools";
import { ReviewFabricSubmissionSchema } from "@/lib/review-fabric/service-contract";
import { requireReviewService } from "@/lib/server/review-service-auth";
import { limitedJson, privateJson, reviewError } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const service = await requireReviewService(req, "reviews:start");
    if (service.response) return service.response;

    const parsed = ReviewFabricSubmissionSchema.safeParse(
      await limitedJson(req, 3_000_000).catch(() => null),
    );
    if (!parsed.success) {
      return privateJson({
        error: parsed.error.issues[0]?.message ?? "Invalid Review Fabric submission",
      }, 400);
    }

    const { request, artifact, context, sources } = parsed.data;
    const headerKey = req.headers.get("idempotency-key");
    if (!headerKey || headerKey !== request.idempotencyKey) {
      return privateJson({ error: "Idempotency-Key must match ReviewRequest.idempotencyKey" }, 400);
    }

    const result = await submitReview(service.auth!.owner, {
      title: artifact.title,
      content: artifact.content,
      artifactType: request.artifactType,
      criticality: request.criticality,
      projectKey: request.projectId,
      context: context.text,
      sources,
      maxCost: request.budget.maxCostUsd,
      additionalInstructions: request.additionalInstructions,
    }, {
      submissionId: request.idempotencyKey,
      invokedBy: "hoss-review-fabric",
      externalMetadata: {
        protocol: "hoss-review-fabric/v1",
        requestId: request.requestId,
        artifactId: request.artifactId,
        artifactContentSha256: request.artifactContentSha256,
        repository: request.repository,
        contextCapsuleId: request.contextCapsuleId,
        contextSha256: request.contextSha256,
        contextCompleteness: context.completeness,
        repositoryBasis: request.repositoryBasis,
        policyRevision: request.policyRevision,
        idempotencyKey: request.idempotencyKey,
        requestedAt: request.requestedAt,
        requestedBy: request.requestedBy,
      },
    });

    return privateJson({
      provider: "model-prism",
      providerRunId: result.reviewId,
      state: result.state,
      phase: result.phase,
      started: result.started,
      requestId: request.requestId,
      artifactId: request.artifactId,
      artifactContentSha256: request.artifactContentSha256,
      maxCostUsd: result.maxCost,
    }, 202);
  } catch (error) {
    return reviewError(error);
  }
}
