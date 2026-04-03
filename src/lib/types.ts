export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  tier: "frontier" | "strong" | "fast";
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
}
