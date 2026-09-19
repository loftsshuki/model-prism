// Explicit local verification preload. Never imported by the application.
import { readFileSync } from 'node:fs';
if (process.env.VERCEL === '1') throw new Error('The mock provider must not run on a hosted deployment');
const snapshot = JSON.parse(readFileSync(new URL('../../src/lib/model-catalog.json', import.meta.url), 'utf8'));
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://openrouter.ai/api/v1/')) return original(input, init);
  if (url.endsWith('/key')) return Response.json({ data: { limit_remaining: 10 } });
  if (url.endsWith('/models')) return Response.json({ data: snapshot.models.map(model => ({ id: model.id, name: model.name, created: model.created, context_length: model.contextLength,
    pricing: { prompt: String(model.inputCostPer1k / 1000), completion: String(model.outputCostPer1k / 1000) }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, top_provider: { max_completion_tokens: model.maxOutputTokens }, supported_parameters: model.supportedParameters, reasoning: model.reasoning })) });
  if (!url.endsWith('/chat/completions')) throw new Error('Unexpected mock-provider route');
  const body = JSON.parse(init?.body ?? '{}');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 3500);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
  });
  const synthesis = { masterDocument: '## Verified background review\n\nThe server completed this synthetic review after the browser was closed.', findings: [{ id: 'finding-1', title: 'Missing owner filter', severity: 'high', recommendation: 'Scope the query to its owner.', supportingModels: ['model:' + snapshot.models[0].id], evidence: [{ source: 'content', quote: 'SELECT * FROM runs' }] }], consensus: [], uniqueInsights: [], disagreements: [], blindSpots: [], themeMatrix: [] };
  const message = body.tools ? { tool_calls: [{ id: 'tool', type: 'function', function: { name: 'synthesis', arguments: JSON.stringify(synthesis) } }] } : { content: 'SELECT * FROM runs omits the owner filter.' };
  return Response.json({ model: body.model, choices: [{ finish_reason: body.tools ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: body.tools ? .05 : .02 } });
};
