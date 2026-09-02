// ═══════════════════════════════════════════════════════════════════════════
// Content-addressed cache of council responses, plus per-run persistence.
//
// Two failure modes cost real money today:
//   - a re-run after a small edit (or with a different judge/synthesizer)
//     re-pays every council member whose input did not change;
//   - a merge-stage failure (judge timeout, schema mismatch) discards the
//     council responses that were already paid for.
// The cache keys a response by everything that shaped it (model, prompt,
// content, context, limits) so an unchanged member is a file read. The
// persisted run stores one review's responses next to the review so
// `--resume` / `--synthesize-only` can rebuild the council without the fan-out.
//
// Node-only (fs/path/crypto). Lives under the gitignored `.model-prism/`,
// cwd-relative, like the telemetry and review ledgers.
// ═══════════════════════════════════════════════════════════════════════════

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface CachedResponse {
  model: string;
  modelName: string;
  family?: string;
  response: string;
  findings?: unknown[];
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  timeMs?: number;
  finishReason?: string | null;
  lens?: string;
  cachedAt: string;
}

const DEFAULT_TTL_DAYS = 30;
const DAY_MS = 86_400_000;

// ── Keys ────────────────────────────────────────────────────────────────────

// JSON.stringify is key-order dependent and would give two keys for the same
// call site depending on how the object literal was written; canonicalize so
// the key depends only on values. `undefined` fields are dropped so an omitted
// option and an explicitly-undefined one hash the same.
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** sha256 over the canonical JSON of the parts, truncated to 32 hex chars. */
export function cacheKey(parts: { model: string; prompt: string; content: string; context?: string; maxTokens?: number; structured?: boolean }): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 32);
}

// Keys become file names; refuse anything that could escape the cache dir.
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) throw new Error(`response-cache: invalid cache key "${key}"`);
}

// ── File helpers ────────────────────────────────────────────────────────────

// Write to a sibling temp file and rename: a crash mid-write leaves a stray
// .tmp (pruned later) rather than a truncated JSON file that reads as corrupt.
function tmpPathFor(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
}

function writeAtomicSync(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    await fs.promises.writeFile(tmp, data, "utf8");
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function readJsonSync(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isCachedResponse(v: unknown): v is CachedResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.model === "string" && typeof o.response === "string" && typeof o.cachedAt === "string";
}

/** Expired when `cachedAt` is unparseable or older than the TTL; a non-finite TTL disables expiry. */
function isExpired(cachedAt: string, ttlDays: number, now = Date.now()): boolean {
  const t = Date.parse(cachedAt);
  if (Number.isNaN(t)) return true;
  if (!Number.isFinite(ttlDays)) return false;
  return now - t > ttlDays * DAY_MS;
}

function defaultCacheDir(): string {
  return path.join(process.cwd(), ".model-prism", "cache");
}

// ── Response cache ──────────────────────────────────────────────────────────

export interface ResponseCache {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse): Promise<void>;
}

/**
 * One JSON file per key under `dir`. Expired and corrupt entries read as
 * misses (never as errors: a bad cache must not fail a review), and writes are
 * atomic so concurrent council members cannot interleave.
 */
export function fileResponseCache(dir: string = defaultCacheDir(), opts: { ttlDays?: number } = {}): ResponseCache {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const fileFor = (key: string) => { assertSafeKey(key); return path.join(dir, `${key}.json`); };
  return {
    async get(key) {
      const file = fileFor(key);
      let raw: string;
      try {
        raw = await fs.promises.readFile(file, "utf8");
      } catch {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!isCachedResponse(parsed) || isExpired(parsed.cachedAt, ttlDays)) return null;
      return { ...parsed, modelName: parsed.modelName || parsed.model };
    },
    async set(key, value) {
      const file = fileFor(key);
      await writeAtomic(file, JSON.stringify({ ...value, cachedAt: value.cachedAt || new Date().toISOString() }));
    },
  };
}

/**
 * Remove expired, corrupt, and stray temp files; then, if `maxFiles` is set,
 * drop the oldest valid entries until the count fits. Returns what happened so
 * the CLI can report it.
 */
export function pruneResponseCache(dir: string = defaultCacheDir(), opts: { ttlDays?: number; maxFiles?: number } = {}): { removed: number; kept: number } {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }
  let removed = 0;
  const remove = (file: string) => {
    try { fs.unlinkSync(file); removed++; } catch { /* already gone */ }
  };
  const kept: Array<{ file: string; at: number }> = [];
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith(".tmp")) { remove(file); continue; }
    if (!name.endsWith(".json")) continue;
    const parsed = readJsonSync(file);
    if (!isCachedResponse(parsed) || isExpired(parsed.cachedAt, ttlDays, now)) { remove(file); continue; }
    kept.push({ file, at: Date.parse(parsed.cachedAt) });
  }
  if (opts.maxFiles !== undefined && kept.length > opts.maxFiles) {
    kept.sort((a, b) => a.at - b.at);
    const excess = kept.splice(0, kept.length - Math.max(0, opts.maxFiles));
    for (const e of excess) remove(e.file);
  }
  return { removed, kept: kept.length };
}

// ── Run persistence ─────────────────────────────────────────────────────────

export interface PersistedRun {
  version: 1;
  plan: string;
  contentHash: string;
  promptHash: string;
  roster: string;
  savedAt: string;
  responses: CachedResponse[];
}

/** `${reviewDir}/${slug}/${contentHash}.responses.json` (platform separators via path.join). */
export function runResponsesPath(reviewDir: string, slug: string, contentHash: string): string {
  return path.join(reviewDir, slug, `${contentHash}.responses.json`);
}

export function saveRunResponses(p: string, run: PersistedRun): void {
  writeAtomicSync(p, JSON.stringify(run, null, 2));
}

/** null when the file is missing, unparseable, or from another format version. */
export function loadRunResponses(p: string): PersistedRun | null {
  const parsed = readJsonSync(p);
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.responses)) return null;
  if (typeof o.plan !== "string" || typeof o.contentHash !== "string") return null;
  if (!o.responses.every(isCachedResponse)) return null;
  return {
    version: 1,
    plan: o.plan,
    contentHash: o.contentHash,
    promptHash: typeof o.promptHash === "string" ? o.promptHash : "",
    roster: typeof o.roster === "string" ? o.roster : "",
    savedAt: typeof o.savedAt === "string" ? o.savedAt : "",
    responses: o.responses as CachedResponse[],
  };
}
