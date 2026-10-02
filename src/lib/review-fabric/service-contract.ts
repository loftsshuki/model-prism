import { createHash } from "node:crypto";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const ReviewFabricArtifactTypeSchema = z.enum([
  "architecture_spec",
  "implementation_plan",
  "migration_plan",
  "product_spec",
  "security_plan",
  "launch_plan",
  "general_plan",
]);

export const ReviewFabricCriticalitySchema = z.enum(["low", "medium", "high"]);

export const ReviewFabricRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(/^review-request:[a-f0-9]{64}$/),
  artifactId: z.string().regex(/^review-artifact:[a-f0-9]{64}$/),
  artifactContentSha256: Sha256Schema,
  provider: z.literal("model-prism"),
  projectId: z.string().trim().min(1).max(200),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  artifactType: ReviewFabricArtifactTypeSchema,
  criticality: ReviewFabricCriticalitySchema,
  contextCapsuleId: z.string().min(1).max(300),
  contextSha256: Sha256Schema,
  repositoryBasis: z.object({
    commitSha: GitShaSchema,
    observedAt: z.string().datetime({ offset: true }),
  }).strict(),
  policyRevision: Sha256Schema,
  budget: z.object({
    maxCostUsd: z.number().finite().min(0.25).max(25),
  }).strict(),
  additionalInstructions: z.string().max(20_000).default(""),
  idempotencyKey: Sha256Schema,
  requestedAt: z.string().datetime({ offset: true }),
  requestedBy: z.object({
    actorType: z.enum(["human", "agent", "service", "system"]),
    actorId: z.string().min(1).max(300),
  }).strict(),
}).strict();

const SourceInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
  text: z.string().max(500_000),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  commit: GitShaSchema.optional(),
  startLine: z.number().int().positive().optional(),
}).strict();

export const ReviewFabricSubmissionSchema = z.object({
  request: ReviewFabricRequestSchema,
  artifact: z.object({
    title: z.string().trim().min(1).max(300),
    content: z.string().min(1).max(500_000),
  }).strict(),
  context: z.object({
    text: z.string().max(1_500_000),
    completeness: z.enum(["complete", "partial", "unavailable"]),
  }).strict(),
  sources: z.array(SourceInputSchema).max(40).default([]),
}).strict().superRefine((value, ctx) => {
  // Mirror the background review limits so an oversized submission is a 400 here,
  // not a downstream failure after key checks.
  value.sources.forEach((source, index) => {
    if (source.startLine !== undefined && source.text.split("\n").length > 100_000) {
      ctx.addIssue({ code: "custom", path: ["sources", index, "text"], message: "A source with startLine may have at most 100,000 lines" });
    }
  });
  if (value.sources.reduce((sum, source) => sum + source.text.length, 0) > 1_500_000) {
    ctx.addIssue({ code: "custom", path: ["sources"], message: "Attached source files exceed the 1,500,000-character review limit" });
  }
  const artifactHash = sha256(value.artifact.content);
  if (artifactHash !== value.request.artifactContentSha256) {
    ctx.addIssue({
      code: "custom",
      path: ["artifact", "content"],
      message: "Artifact content SHA-256 does not match ReviewRequest",
    });
  }
  const contextHash = sha256(value.context.text);
  if (contextHash !== value.request.contextSha256) {
    ctx.addIssue({
      code: "custom",
      path: ["context", "text"],
      message: "Context SHA-256 does not match ReviewRequest",
    });
  }
});

export type ReviewFabricRequest = z.infer<typeof ReviewFabricRequestSchema>;
export type ReviewFabricSubmission = z.infer<typeof ReviewFabricSubmissionSchema>;

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseRunMetadata(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

type Finding = {
  title?: unknown;
  severity?: unknown;
  recommendation?: unknown;
};

export function normalizeFindings(synthesis: unknown) {
  if (!synthesis || typeof synthesis !== "object") {
    return {
      findingCounts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      materialFindings: [] as Array<{ severity: "critical" | "high" | "medium" | "low"; title: string; summary: string }>,
    };
  }
  const raw = Array.isArray((synthesis as { findings?: unknown }).findings)
    ? (synthesis as { findings: Finding[] }).findings
    : [];
  const valid = raw.flatMap(finding => {
    if (!finding || typeof finding !== "object") return [];
    const severity = String(finding.severity ?? "");
    if (!["critical", "high", "medium", "low"].includes(severity)) return [];
    // A finding still counts by severity when its text is incomplete; dropping it
    // could turn a critical issue into "no material objection".
    const summary = String(finding.recommendation ?? "").trim();
    const title = String(finding.title ?? "").trim() || summary.slice(0, 120) || "Untitled finding";
    return [{ severity: severity as "critical" | "high" | "medium" | "low", title, summary: summary || title }];
  });
  const findingCounts = {
    critical: valid.filter(finding => finding.severity === "critical").length,
    high: valid.filter(finding => finding.severity === "high").length,
    medium: valid.filter(finding => finding.severity === "medium").length,
    low: valid.filter(finding => finding.severity === "low").length,
    total: valid.length,
  };
  return { findingCounts, materialFindings: valid.slice(0, 100) };
}

export function reviewDisposition(state: string, synthesis: unknown) {
  if (state === "error") return "failed" as const;
  if (state === "stopped") return "stopped" as const;
  if (state !== "complete" || !synthesis || typeof synthesis !== "object") return "inconclusive" as const;
  // Without a structured findings list the verdict cannot be computed; the master
  // document may still describe critical problems. Never report "no objection" then.
  if (!Array.isArray((synthesis as { findings?: unknown }).findings)) return "inconclusive" as const;
  const { findingCounts } = normalizeFindings(synthesis);
  if (findingCounts.critical + findingCounts.high > 0) return "material_revision_required" as const;
  const disagreements = Array.isArray((synthesis as { disagreements?: unknown }).disagreements)
    ? (synthesis as { disagreements: unknown[] }).disagreements.length
    : 0;
  const blindSpots = Array.isArray((synthesis as { blindSpots?: unknown }).blindSpots)
    ? (synthesis as { blindSpots: unknown[] }).blindSpots.length
    : 0;
  if (findingCounts.total > 0 || disagreements > 0 || blindSpots > 0) return "revisions_recommended" as const;
  return "no_material_objection" as const;
}

export function synthesisMarkdown(synthesis: unknown) {
  if (!synthesis || typeof synthesis !== "object") return null;
  const value = (synthesis as { masterDocument?: unknown }).masterDocument;
  return typeof value === "string" && value.trim() ? value : null;
}
