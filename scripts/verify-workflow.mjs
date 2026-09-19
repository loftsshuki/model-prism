import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { neon } from '@neondatabase/serverless';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (!process.env.DATABASE_URL || !process.env.MODEL_PRISM_ENCRYPTION_KEY) throw new Error('Configure DATABASE_URL and MODEL_PRISM_ENCRYPTION_KEY for local workflow verification');
mkdirSync('.model-prism', { recursive: true });
const port = 3112, base = `http://127.0.0.1:${port}`;
const providerKey = `sk-or-verification-${randomUUID()}`;
const capability = createHash('sha256').update('model-prism-cloud-v1:' + providerKey).digest('hex');
const owner = createHash('sha256').update(capability).digest('hex');
const log = '.model-prism/workflow-verification.log'; writeFileSync(log, '');
const preload = pathToFileURL(fileURLToPath(new URL('../tests/fixtures/provider-preload.mjs', import.meta.url))).href;
const server = spawn(process.execPath, ['--import', preload, 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, VERCEL: '', WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_BASE_URL: base, WORKFLOW_LOCAL_DATA_DIR: '.model-prism/workflow-verification-data', WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
server.stdout.on('data', chunk => appendFileSync(log, chunk)); server.stderr.on('data', chunk => appendFileSync(log, chunk));
const sql = neon(process.env.DATABASE_URL);
let browser;
const headers = { 'x-model-prism-owner': capability, 'Content-Type': 'application/json' };
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(base).then(response => response.ok).catch(() => false)) break;
    if (attempt === 59) throw new Error('Local verification server failed to start');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const installedChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync(installedChrome) ? installedChrome : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addInitScript(key => sessionStorage.setItem('openrouter-api-key', key), providerKey);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('Content to review', { exact: true }).fill('Synthetic verification: SELECT * FROM runs');
  await page.getByLabel('Keep running after you close this tab').check();
  const submitted = page.waitForResponse(response => response.url() === base + '/api/reviews' && response.request().method() === 'POST');
  await page.getByTestId('run-button').click();
  const submission = await submitted; const data = await submission.json();
  const submittedBody = submission.request().postDataJSON();
  assert.equal(submission.status(), 202, JSON.stringify(data));
  assert.ok(data.id);
  await page.close();
  console.log('Browser closed after dispatch; waiting for durable worker completion');
  let run;
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${base}/api/runs/${data.id}`, { headers });
    run = (await response.json()).run;
    if (['complete', 'error', 'stopped'].includes(run?.snapshot?.background?.state)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(run?.snapshot?.background?.state, 'complete', run?.snapshot?.error ?? 'Workflow did not complete');
  assert.equal(run.snapshot.responses.filter(response => response.status === 'complete').length, 5);
  assert.equal(Math.round(run.total_cost * 100), 15);
  const replay = await fetch(`${base}/api/reviews`, { method: 'POST', headers, body: JSON.stringify(submittedBody) }).then(response => response.json());
  assert.equal(replay.started, false); assert.equal(replay.snapshot.background.execution, run.snapshot.background.execution);
  const privateCheck = await fetch(`${base}/api/runs/${data.id}`); assert.equal(privateCheck.status, 404);
  const tamper = await fetch(`${base}/api/runs/${data.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...run.snapshot, revision: 99999, usage: [] }) }); assert.equal(tamper.status, 409);
  const findings = await fetch(`${base}/api/runs/${data.id}/findings`, { headers }).then(r => r.json()); assert.equal(findings.findings.length, 1);
  const decision = await fetch(`${base}/api/runs/${data.id}/findings`, { method: 'PATCH', headers, body: JSON.stringify({ fingerprint: findings.findings[0].fingerprint, state: 'accepted', note: 'Synthetic browser verification' }) }); assert.equal(decision.status, 200);
  const [stored] = await sql`SELECT credential FROM review_jobs WHERE run_id=${data.id}`; assert.equal(stored.credential, null);
  const storedWorkflow = '.model-prism/workflow-verification-data';
  for (const file of readdirSync(storedWorkflow, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())) {
    assert.equal(readFileSync(`${file.parentPath}/${file.name}`, 'utf8').includes(providerKey), false, 'Provider key must not appear in workflow inputs, outputs, or logs');
  }
  const restored = await context.newPage(); await restored.goto(`${base}/?resume=${data.id}`);
  await restored.getByRole('button', { name: 'Restore review', exact: true }).click();
  await restored.getByRole('heading', { name: 'Master Synthesis', exact: true }).waitFor();
  await restored.getByLabel('Decision for Missing owner filter').waitFor();
  assert.equal(await restored.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await restored.screenshot({ path: '.model-prism/background-mobile-verified.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: mobile browser → API → durable workflow → database → private restore → accepted finding; five reviewers and synthesis completed after the tab closed; cost $0.15 (mock provider, $0 actual spend)');
} finally {
  await browser?.close();
  server.kill();
  const rows = await sql`SELECT id FROM runs WHERE owner_key=${owner}`;
  for (const row of rows) await sql`DELETE FROM runs WHERE id=${row.id} AND owner_key=${owner}`;
  await sql`DELETE FROM review_findings WHERE owner_key=${owner}`;
  console.log('Synthetic workflow records removed');
}
