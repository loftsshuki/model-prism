import { NextRequest } from "next/server";
import { getReviewResult } from "@/lib/mcp/review-tools";
import {
  normalizeFindings,
  parseRunMetadata,
  reviewDisposition,
  sha256,
  synthesisMarkdown,
} from "@/lib/review-fabric/service-contract";
import { requireReviewService } from "@/lib/server/review-service-auth";
import { privateJson, reviewError } from "@/lib/server/http";

function serviceMetadata(value: unknown) {
  const metadata = parseRunMetadata(value);
  if (!metadata || metadata.invokedBy !== "hoss-review-fabric") return null;
  const external = metadata.external;
  if (!external || typeof external !== "object" || Array.isArray(external)) return null;
  const record = external as Record<string, unknown>;
  if (record.protocol !== "hoss-review-fabric/v1") return null;
  return record;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const service = await requireReviewService(req, "reviews:read");
    if (service.response) return service.response;
    const { id } = await params;
    const result = await getReviewResult(service.auth!.owner, {
      reviewId: id,
      includeModelResponses: false,
    });
    const external = serviceMetadata(result.contextMetadata);
    if (!external) return privateJson({ error: "Review Fabric run not found" }, 404);

    const state = String(result.state ?? "queued");
    const synthesis = result.synthesis;
    const markdown = synthesisMarkdown(synthesis);
    const { findingCounts, materialFindings } = normalizeFindings(synthesis);
    const terminal = ["complete", "error", "stopped"].includes(state);
    const models = Array.isArray(result.models)
      ? result.models.map(model => typeof model === "string" ? model : String((model as { id?: unknown }).id ?? "")).filter(Boolean)
      : [];

    return privateJson({
      provider: "model-prism",
      providerRunId: result.reviewId,
      providerState: state,
      phase: result.phase ?? null,
      startedAt: new Date(String(result.createdAt)).toISOString(),
      completedAt: terminal && result.updatedAt ? new Date(String(result.updatedAt)).toISOString() : null,
      costUsd: Number(result.totalCost ?? 0),
      roster: models,
      synthesisModel: result.synthesisModel ? String(result.synthesisModel) : null,
      disposition: reviewDisposition(state, synthesis),
      findingCounts,
      materialFindings,
      synthesisMarkdown: markdown,
      synthesisSha256: markdown ? sha256(markdown) : null,
      contextCompleteness: external.contextCompleteness ?? "partial",
      error: result.error ?? null,
      hoss: {
        requestId: external.requestId,
        artifactId: external.artifactId,
        artifactContentSha256: external.artifactContentSha256,
        repository: external.repository,
        contextCapsuleId: external.contextCapsuleId,
        contextSha256: external.contextSha256,
        repositoryBasis: external.repositoryBasis,
        policyRevision: external.policyRevision,
        idempotencyKey: external.idempotencyKey,
        requestedAt: external.requestedAt,
        requestedBy: external.requestedBy,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Review not found") {
      return privateJson({ error: "Review Fabric run not found" }, 404);
    }
    return reviewError(error);
  }
}
