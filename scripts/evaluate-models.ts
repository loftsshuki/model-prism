import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchModelCatalog, getCouncilModels, SYNTHESIS_IDS } from "../src/lib/model-catalog";
import { requestCompletion, ProviderError } from "../src/lib/openrouter-client";
import { RunBudget, BudgetExceededError } from "../src/lib/run-budget";
import { evaluationContent, evaluationPrompt, parseEvaluationAnswer, scoreEvaluation, summarizeEvaluations, type EvaluationFixture, type EvaluationFinding } from "../src/lib/evaluation";
import { fanOut } from "../src/lib/fan-out";
import { synthesizeViaOpenRouter } from "../src/lib/synthesis";
import { initialCouncil, escalationReasons } from "../src/lib/review-policy";
import { evidenceLocations } from "../src/lib/finding-tracking";
import type { ModelInfo, ModelResponse, SynthesisResult } from "../src/lib/types";

const arg = (name: string, fallback = "") => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] ?? ""; };
async function council(fixture: EvaluationFixture, models: ModelInfo[], catalog: ModelInfo[], apiKey: string, budget: RunBudget, adaptive: boolean, highRisk: boolean) {
  const selected = initialCouncil(models, adaptive, highRisk ? "high" : "standard");
  const content = evaluationContent(fixture), prompt = evaluationPrompt(fixture);
  const sources = fixture.files.map((file, index) => ({ id: `file:${file.path}:${index}`, path: file.path, text: file.text, lineNumbers: file.text.split("\n").map((_, i) => file.startLine + i) }));
  const review = (roster: ModelInfo[]) => fanOut({ models: roster, catalog, apiKey, budget, content, prompt, runId: null, maxTokens: 4096, maxAttempts: 1, reasoningEffort: "low", isAborted: () => false, onUpdate: () => {} });
  let responses = await review(selected);
  let reasons: string[] = [], added: string[] = [];
  const remaining = models.filter(model => !selected.some(item => item.id === model.id));
  if (adaptive && responses.filter(response => response.status === "complete").length < 2 && remaining.length) {
    reasons.push("Too few initial reviewers completed"); added = remaining.map(model => model.id);
    responses = [...responses, ...await review(remaining)];
  }
  const synthesize = async (answers: ModelResponse[]) => {
    const successful = answers.filter(answer => answer.status === "complete" && answer.response);
    if (successful.length < 2) throw new Error("Too few completed reviewers for synthesis");
    const model = catalog.find(model => model.id === SYNTHESIS_IDS.sonnet);
    if (!model) throw new Error("Configured synthesis model is unavailable");
    return synthesizeViaOpenRouter({ openrouterKey: apiKey, budget, modelId: model.id, model, content, sources,
      analysisPrompt: `${prompt}\nIn the final synthesis, prefix every finding title with [${fixture.rule}] and cite the exact file source ID. Findings outside the contract are out of scope.`,
      responses: successful.map(answer => ({ model: answer.model, modelName: answer.modelName, family: answer.family ?? "unknown", response: answer.response! })),
      maxTokens: 4096, reasoningEffort: "low", retryOptions: { maxAttempts: 1 } });
  };
  let synthesis = await synthesize(responses);
  if (adaptive && !added.length && remaining.length) {
    reasons = escalationReasons(synthesis, responses.filter(response => response.status === "complete").length, highRisk ? "high" : "standard");
    if (reasons.length) { added = remaining.map(model => model.id); responses = [...responses, ...await review(remaining)]; synthesis = await synthesize(responses); }
  }
  const findings: EvaluationFinding[] = (synthesis.findings ?? []).map(finding => {
    const [location] = evidenceLocations(finding, sources);
    const quote = finding.evidence.find(evidence => evidence.source === location?.sourceId)?.quote ?? finding.evidence[0]?.quote ?? "";
    return { rule: /^\[([^\]]+)\]/.exec(finding.title)?.[1] ?? finding.id, path: location?.path ?? "unresolved", line: location?.startLine ?? 1, quote, explanation: finding.recommendation };
  });
  return { findings, selection: { initial: selected.map(model => model.id), added, reasons }, synthesis: { findings: synthesis.findings, blindSpots: synthesis.blindSpots } as Pick<SynthesisResult, "findings" | "blindSpots"> };
}

async function main() {
  const dataset = JSON.parse(readFileSync(arg("--dataset", "evals/repository-regressions.json"), "utf8")) as { scope: string; fixtures: EvaluationFixture[] };
  const limit = Number(arg("--limit", String(dataset.fixtures.length)));
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const fixtures = dataset.fixtures.filter(fixture => !arg("--fixture") || fixture.id === arg("--fixture")).slice(0, limit);
  if (!fixtures.length) throw new Error("No matching evaluation fixtures");
  const mode = arg("--mode", "individual");
  if (!["individual", "fixed", "adaptive", "compare"].includes(mode)) throw new Error("--mode must be individual, fixed, adaptive, or compare");
  if (!process.argv.includes("--live")) {
    console.log(JSON.stringify({ fixtures: fixtures.length, repositoryCases: fixtures.filter(f => f.provenance.kind === "repository").length,
      safeControls: fixtures.filter(f => !f.expected.length).length, scope: dataset.scope, mode,
      usage: "Opt in with --live --max-cost <USD>. Optional: --models id,id --roster balanced|cheap|frontier --mode compare --limit 2 --out report.json. No provider calls were made." }, null, 2)); return;
  }
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY required");
  const ceiling = Number(arg("--max-cost"));
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 100) throw new Error("Specify an explicit --max-cost between 0 and 100 USD");
  const budget = new RunBudget(ceiling);
  const catalog = await fetchModelCatalog();
  const roster = arg("--roster", "balanced");
  if (!["balanced", "cheap", "frontier"].includes(roster)) throw new Error("Unknown curated roster");
  const ids = arg("--models").split(",").filter(Boolean);
  const models = ids.length ? ids.map(id => { const model = catalog.find(model => model.id === id); if (!model) throw new Error(`Unavailable model ${id}`); return model; }) : getCouncilModels(roster as "balanced" | "cheap" | "frontier", catalog);
  if (mode !== "individual" && models.length < 2) throw new Error("A council comparison requires at least two models");
  const variants = mode === "individual" ? models.map(model => model.id) : mode === "compare" ? ["fixed", "adaptive"] : [mode];
  const results: Array<ReturnType<typeof scoreEvaluation> & { variant: string; fixture: string; findings: EvaluationFinding[]; selection?: unknown; error?: string; cost: number; timeMs: number }> = [];
  let blocked = false, budgetStopped = false;
  evaluation: for (const fixture of fixtures) for (const variant of variants) {
    const started = Date.now(), costBefore = budget.spent;
    let findings: EvaluationFinding[] = [], valid = true, failure: string | undefined, selection: unknown;
    try {
      if (mode === "individual") {
        const result = await requestCompletion({ apiKey, model: models.find(model => model.id === variant)!, budget, maxTokens: 4096, maxAttempts: 1, reasoningEffort: "low", messages: [{ role: "user", content: `${evaluationPrompt(fixture)}\n\n${evaluationContent(fixture)}` }] });
        if (result.choices[0]?.finish_reason !== "stop") throw new Error("Incomplete model output");
        findings = parseEvaluationAnswer(result.choices[0]?.message.content ?? "");
      } else {
        const result = await council(fixture, models, catalog, apiKey, budget, variant === "adaptive", process.argv.includes("--high-risk"));
        findings = result.findings; selection = result.selection;
      }
    } catch (error) {
      valid = false; failure = (error instanceof Error ? error.message : "Evaluation failed").replace(/sk-or-[\w-]+/g, "[redacted]");
      blocked = error instanceof ProviderError && [401, 402, 403].includes(error.status);
      budgetStopped = error instanceof BudgetExceededError || /spending limit/i.test(failure);
    }
    results.push({ variant, fixture: fixture.id, ...scoreEvaluation(fixture, findings, valid), findings, selection, error: failure, cost: budget.spent - costBefore, timeMs: Date.now() - started });
    if (blocked || budgetStopped) break evaluation;
  }
  const report = { evaluatedAt: new Date().toISOString(), mode, blocked, budgetStopped, complete: results.length === fixtures.length * variants.length,
    requestedCases: fixtures.length * variants.length, completedCases: results.length, scope: dataset.scope,
    note: "Frozen repository regressions with explicit contracts and safe controls. No general model ranking is inferred. Review fresh private project examples before promoting a roster.",
    cost: budget.spent, limit: ceiling, usage: budget.usage,
    summaries: Object.fromEntries(variants.map(variant => [variant, summarizeEvaluations(results.filter(row => row.variant === variant))])), results };
  if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (!report.complete || results.some(row => !row.pass)) process.exitCode = blocked ? 2 : 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
