// --- Context Pack types ---

export interface GitHubRepo {
  full_name: string;       // "loftsshuki/LuxuryApartments"
  default_branch: string;
  private: boolean;
}

export interface RepoFile {
  path: string;            // "src/app/page.tsx"
  size: number;            // bytes
  type: "file" | "dir";
}

export interface FetchTreeResult {
  files: RepoFile[];
  truncated: boolean;
}

export type FileFetchResult =
  | { ok: true; content: string; size: number }
  | { ok: false; reason: "too_large" | "binary" | "decode_failed" | "not_found" | "blocked" };

export interface PatValidationResult {
  valid: boolean;
  username?: string;
  scopes?: string[];       // from X-OAuth-Scopes header
  errorType?: "bad_token" | "insufficient_scope" | "sso_required" | "rate_limited";
  message?: string;
}

export interface ContextPack {
  version: 1;
  id: string;              // "pack_${timestamp}"
  name: string;            // "LuxApts Core"
  repo: string;            // "loftsshuki/LuxuryApartments"
  branch: string;          // "main"
  brief: string;           // The repo brief text (user-editable)
  briefEnhanced: boolean;  // true if AI-enhanced
  selectedFiles: string[]; // Paths of files to attach (contents fetched on demand)
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
}

export interface GitHubApiError {
  status: number;
  message: string;
  retryable: boolean;
  resetAt?: number;        // Unix timestamp for rate limit reset
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: number;         // Unix timestamp
}

// --- Model types ---

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  tier: "frontier" | "strong" | "fast" | "free";
  contextLength: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
}

export interface ModelResponse {
  model: string;
  modelName: string;
  status: "pending" | "streaming" | "complete" | "error";
  response?: string;
  error?: string;
  timeMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface RunState {
  id: string;
  content: string;
  prompt: string;
  models: ModelInfo[];
  responses: ModelResponse[];
  status: "idle" | "running" | "synthesizing" | "complete";
  synthesis?: SynthesisResult;
  totalCost: number;
}

export interface SynthesisResult {
  masterDocument?: string;
  consensus: Array<{
    point: string;
    supportingModels: string[];
    strength: "strong" | "moderate" | "weak";
  }>;
  uniqueInsights: Array<{
    model: string;
    insight: string;
    significance: "high" | "medium" | "low";
  }>;
  disagreements: Array<{
    topic: string;
    positions: Array<{
      models: string[];
      position: string;
    }>;
  }>;
  blindSpots: string[];
  themeMatrix?: Array<{
    theme: string;
    scores: Record<string, number>;
  }>;
}
