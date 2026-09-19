import { z } from "zod";
import type { ModelInfo, SynthesisResult } from "./types";

export const SourceDocumentSchema = z.object({
  id: z.string().regex(/^file:.+/).max(550), path: z.string().min(1).max(500), text: z.string().max(500_000),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  commit: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
  lineNumbers: z.array(z.number().int().positive()).max(100_000).optional(),
}).refine(source => !source.lineNumbers || source.lineNumbers.length === source.text.split("\n").length, "Source line map does not match the file");
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const BackgroundReviewSchema = z.object({
  id: z.string().regex(/^run_[a-zA-Z0-9_-]+$/).max(100),
  content: z.string().min(1).max(500_000), prompt: z.string().min(1).max(50_000), context: z.string().max(2_000_000).default(""),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
  modelIds: z.array(z.string().min(1).max(200)).min(2).max(10).refine(ids => new Set(ids).size === ids.length, "Choose distinct reviewers"),
  synthesisModel: z.string().min(1).max(200), maxCost: z.number().finite().min(0.01).max(100),
  maxTokens: z.number().int().min(256).max(32768).default(8192), synthesisMaxTokens: z.number().int().min(256).max(65536).default(16384),
  adaptive: z.boolean().default(false), risk: z.enum(["standard", "high"]).default("standard"),
  allowPaidFallback: z.boolean().default(false),
  secondPass: z.boolean().default(false), contextMetadata: z.string().max(20_000).optional(),
  projectKey: z.string().trim().min(1).max(200).default("default"), baselineRunId: z.string().max(100).optional(),
  sources: z.array(SourceDocumentSchema).max(100).default([]),
}).refine(input => input.sources.reduce((sum, source) => sum + source.text.length, 0) <= 1_500_000, "Attached source files exceed the review limit")
  .refine(input => new Set(input.sources.map(source => source.id)).size === input.sources.length, "Source IDs must be unique");
export type BackgroundReviewInput = z.infer<typeof BackgroundReviewSchema>;

export function initialCouncil(models: ModelInfo[], adaptive: boolean, risk: "standard" | "high") {
  if (!adaptive || risk === "high") return models;
  // Keep the user's priority order while preferring independent model families.
  const first: ModelInfo[] = [];
  for (const model of models) {
    if (!first.some(item => item.family === model.family)) first.push(model);
    if (first.length === 3) return first;
  }
  return [...first, ...models.filter(model => !first.includes(model))].slice(0, 3);
}

export function escalationReasons(synthesis: SynthesisResult, complete: number, risk: "standard" | "high"): string[] {
  const reasons: string[] = [];
  if (risk === "high") reasons.push("High-risk review requested");
  if (complete < 3) reasons.push("Fewer than three reviewers completed");
  if (synthesis.disagreements.length) reasons.push("Reviewers reported unresolved disagreements");
  if (synthesis.findings?.some(finding => ["critical", "high"].includes(finding.severity))) reasons.push("A reviewer raised a high-impact finding");
  if (synthesis.findings?.some(finding => !finding.evidenceVerified)) reasons.push("Some findings lack verified quotations");
  if (synthesis.blindSpots.length) reasons.push("The first synthesis identified missing coverage");
  return reasons;
}
