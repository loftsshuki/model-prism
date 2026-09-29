import { NextRequest } from "next/server";
import { getReviewResult, stopReview } from "@/lib/mcp/review-tools";
import { parseRunMetadata } from "@/lib/review-fabric/service-contract";
import { requireReviewService } from "@/lib/server/review-service-auth";
import { privateJson, reviewError } from "@/lib/server/http";

function isServiceRun(value: unknown) {
  const metadata = parseRunMetadata(value);
  if (!metadata || metadata.invokedBy !== "hoss-review-fabric") return false;
  const external = metadata.external;
  return Boolean(
    external
    && typeof external === "object"
    && !Array.isArray(external)
    && (external as Record<string, unknown>).protocol === "hoss-review-fabric/v1"
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const service = await requireReviewService(req, "reviews:stop");
    if (service.response) return service.response;
    const { id } = await params;
    const result = await getReviewResult(service.auth!.owner, {
      reviewId: id,
      includeModelResponses: false,
    });
    if (!isServiceRun(result.contextMetadata)) {
      return privateJson({ error: "Review Fabric run not found" }, 404);
    }
    await stopReview(service.auth!.owner, { reviewId: id });
    return privateJson({ provider: "model-prism", providerRunId: id, stopping: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Review not found") {
      return privateJson({ error: "Review Fabric run not found" }, 404);
    }
    return reviewError(error);
  }
}
