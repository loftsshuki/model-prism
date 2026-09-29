import { describe, expect, test } from "bun:test";
import {
  ReviewFabricSubmissionSchema,
  normalizeFindings,
  reviewDisposition,
  sha256,
} from "./service-contract";

function submission() {
  const content = "# Plan\n\nBuild the review fabric.";
  const context = "Current repo state";
  return {
    request: {
      schemaVersion: 1 as const,
      requestId: "review-request:" + "1".repeat(64),
      artifactId: "review-artifact:" + "2".repeat(64),
      artifactContentSha256: sha256(content),
      provider: "model-prism" as const,
      projectId: "hoss",
      repository: "loftsshuki/HOSS",
      artifactType: "implementation_plan" as const,
      criticality: "medium" as const,
      contextCapsuleId: "ctx_test",
      contextSha256: sha256(context),
      repositoryBasis: {
        commitSha: "3".repeat(40),
        observedAt: "2026-09-28T20:00:00.000Z",
      },
      policyRevision: "4".repeat(64),
      budget: { maxCostUsd: 6 },
      additionalInstructions: "",
      idempotencyKey: "5".repeat(64),
      requestedAt: "2026-09-28T20:01:00.000Z",
      requestedBy: { actorType: "service" as const, actorId: "hoss" },
    },
    artifact: { title: "Review Fabric", content },
    context: { text: context, completeness: "complete" as const },
    sources: [],
  };
}

describe("Review Fabric service contract", () => {
  test("accepts exact hash-bound HOSS submission", () => {
    expect(ReviewFabricSubmissionSchema.safeParse(submission()).success).toBe(true);
  });

  test("rejects artifact or context bytes that do not match the request hashes", () => {
    const artifact = submission();
    artifact.artifact.content += "\nchanged";
    expect(ReviewFabricSubmissionSchema.safeParse(artifact).success).toBe(false);

    const context = submission();
    context.context.text += "\nchanged";
    expect(ReviewFabricSubmissionSchema.safeParse(context).success).toBe(false);
  });

  test("normalizes findings and disposition deterministically", () => {
    const synthesis = {
      masterDocument: "Review",
      findings: [
        { title: "Critical gap", severity: "high", recommendation: "Fix the gate" },
        { title: "Polish", severity: "low", recommendation: "Improve the copy" },
      ],
      disagreements: [],
      blindSpots: [],
    };
    expect(normalizeFindings(synthesis).findingCounts).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 1,
      total: 2,
    });
    expect(reviewDisposition("complete", synthesis)).toBe("material_revision_required");
    expect(reviewDisposition("error", null)).toBe("failed");
    expect(reviewDisposition("stopped", null)).toBe("stopped");
  });

  test("treats unresolved synthesis coverage as revision-worthy", () => {
    expect(reviewDisposition("complete", {
      masterDocument: "No direct findings",
      findings: [],
      disagreements: [{ topic: "Boundary" }],
      blindSpots: [],
    })).toBe("revisions_recommended");
  });
});
