/**
 * Ground-truth pre-checks — zero-LLM-cost verification of what a plan references.
 *
 * Council models hallucinate most reliably about *specific* things: a file that
 * "already handles this", a helper that "should be reused", a table that "has an
 * index". This module pulls those references out of the plan (paths, symbols,
 * tables, env vars), checks each one against the actual repository, and renders
 * a `<verified_facts>` block that is injected into every council prompt. A
 * "missing" verdict is deliberately treated as ground truth: the model is told
 * the thing does not exist yet, so it stops assuming and starts saying so.
 *
 * Extraction is conservative on purpose. A false "missing" is worse than a
 * skipped reference — it would teach the council that something real is
 * fictional — so bare prose words, URLs and framework names are filtered out
 * and only tokens that unambiguously look like code are checked.
 *
 * Node-only (fs / path / child_process): CLI and API routes, never the browser
 * bundle. Symbol/table/env lookups use `git grep` when available and fall back
 * to a bounded filesystem walk otherwise.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { walkRepo } from "./local-context";

// ── Public types ────────────────────────────────────────────────────────────

export interface GroundTruthRef {
  kind: "path" | "symbol" | "table" | "env";
  name: string;
  status: "found" | "missing" | "ambiguous";
  /** Up to 5 "path:line" (grep hits) or paths (filesystem hits). */
  matches: string[];
  note?: string;
}

export interface GroundTruthReport {
  refs: GroundTruthRef[];
  found: number;
  missing: number;
  ambiguous: number;
  durationMs: number;
}

export interface GroundTruthOptions {
  /** Hard cap on references checked; the rest are reported as "not checked (budget)". Default 80. */
  maxRefs?: number;
  /** Wall-clock budget for the grep phase. Default 10s. */
  timeoutMs?: number;
  /**
   * Which search backend to use. "auto" (default) tries `git grep` and falls
   * back to a filesystem walk when git is unavailable or the root is not a repo.
   * Tests use "fs" to exercise the fallback deterministically.
   */
  backend?: "auto" | "git" | "fs";
  /**
   * Repo-relative path of the plan being reviewed, when it lives inside the
   * repo. It is excluded from greps so a plan cannot "verify" its own claims.
   */
  planPath?: string;
}

const DEFAULT_MAX_REFS = 80;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_MATCHES = 5;
const MAX_FILE_BYTES = 1_000_000; // never read files larger than 1 MB
const MAX_INDEX_BYTES = 30_000_000; // total bytes the fs fallback will hold in memory

// ── Extraction ──────────────────────────────────────────────────────────────

const KNOWN_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "md", "mdx",
  "sql", "yml", "yaml", "toml", "css", "scss", "html", "py", "rb", "go", "rs",
  "java", "kt", "sh", "txt", "prisma", "graphql", "gql", "svg", "png", "xml",
  "lock", "csv", "tf", "ini", "cfg", "conf", "vue", "svelte", "env", "example",
]);

// A slash-path without an extension (e.g. `src/lib/`) still counts when it
// starts at a conventional repo root; "and/or" or "read/write" do not.
const KNOWN_ROOT_DIRS = new Set([
  "src", "app", "lib", "components", "pages", "public", "api", "utils", "hooks",
  "services", "config", "test", "tests", "scripts", "styles", "assets", "prisma",
  "drizzle", "server", "client", "shared", "core", "types", "models", "db",
  "migrations", "supabase", "docs", "packages", "apps", "functions", "internal",
  "cmd", "pkg", ".github",
]);

// Product names that look like files with a known extension.
const FRAMEWORK_DOTTED = new Set([
  "next.js", "node.js", "react.js", "vue.js", "express.js", "three.js", "d3.js",
  "ember.js", "nuxt.js", "nest.js", "deno.js", "bun.js", "backbone.js",
  "angular.js", "alpine.js", "chart.js", "socket.io", "web.dev", "asp.net",
]);

// Language keywords and globals that appear in backticks but are not repo symbols.
const SYMBOL_STOPWORDS = new Set([
  "true", "false", "null", "undefined", "async", "await", "const", "function",
  "return", "import", "export", "default", "class", "interface", "type", "enum",
  "string", "number", "boolean", "void", "never", "unknown", "object", "promise",
  "array", "record", "partial", "error", "date", "json", "math", "console",
  "process", "window", "document", "require", "module", "exports", "this",
  "super", "delete", "typeof", "instanceof", "todo", "note", "fixme", "yield",
  "extends", "implements", "static", "public", "private", "readonly", "while",
  "switch", "throw", "catch", "finally", "continue", "break", "select", "where",
  "insert", "update", "values", "table", "index", "create", "alter", "drop",
]);

const SQL_KEYWORDS = new Set([
  "select", "where", "set", "into", "values", "only", "if", "not", "exists",
  "on", "using", "as", "and", "or", "the", "a", "an", "this", "that", "each",
]);

export interface ExtractedReferences {
  paths: string[];
  symbols: string[];
  tables: string[];
  envVars: string[];
}

function extOf(token: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(token);
  return m ? m[1].toLowerCase() : "";
}

/** Strips wrapping punctuation and rejects URLs / absolute paths / node_modules. */
function normalizePathToken(raw: string): string | null {
  let t = raw.trim();
  // Peel wrapping punctuation one layer at a time. Brackets are only stripped
  // when they wrap the whole token or are unbalanced, so `app/(auth)/page.tsx`
  // and `[id]` survive while `(src/lib/db.ts).` becomes `src/lib/db.ts`.
  for (;;) {
    const before = t;
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === "(" && last === ")") || (first === "[" && last === "]")) t = t.slice(1, -1);
    else if (first === "(" && !t.includes(")")) t = t.slice(1);
    else if (first === "[" && !t.includes("]")) t = t.slice(1);
    else if (first && "\"'<{".includes(first)) t = t.slice(1);
    else if (last && ".,;:!?\"'>}*".includes(last)) t = t.slice(0, -1);
    else if (last === ")" && count(t, ")") > count(t, "(")) t = t.slice(0, -1);
    else if (last === "]" && count(t, "]") > count(t, "[")) t = t.slice(0, -1);
    if (t === before || t.length === 0) break;
  }
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("www.")) return null;
  if (t.includes("node_modules")) return null;
  if (t.startsWith("./")) t = t.slice(2);
  // Absolute and parent-relative paths are not repo-relative; skip rather than guess.
  if (t.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(t) || t.split("/").includes("..")) return null;
  if (!/^[\w.@+-]+(?:\/[\w.@+\-[\]()]+)*\/?$/.test(t)) return null;
  return t;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function isPathLike(t: string, backticked: boolean): boolean {
  const ext = extOf(t.replace(/\/$/, ""));
  const known = KNOWN_EXTS.has(ext);
  if (t.includes("/")) {
    const segs = t.split("/").filter(Boolean);
    if (segs.length < 2) return false;
    return known || KNOWN_ROOT_DIRS.has(segs[0]);
  }
  if (!known) return false;
  if (FRAMEWORK_DOTTED.has(t.toLowerCase())) return false;
  // Version-ish tokens (`1.2.3`) have digit "extensions" and never reach here,
  // but `Foo.ts` in prose is more likely a class than a file unless backticked.
  if (!backticked && !/^[a-z0-9_.-]+$/.test(t)) return false;
  // A bare extension with no name (`.ts`) is a file type, not a file.
  return !t.startsWith(".") || t.split(".").length > 2;
}

function looksLikeCodeSymbol(name: string): boolean {
  if (name.includes("(")) return true;
  if (name.includes("_") || name.includes(".")) return true;
  return /[a-z][A-Z]/.test(name); // camelCase / PascalCase hump
}

function extractSymbolFromSpan(span: string): string | null {
  const m = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(\([^)]*\))?$/.exec(span.trim());
  if (!m) return null;
  let name = m[1];
  const hasCall = Boolean(m[2]);
  if (/^process\.env\./.test(name)) return null; // env var, handled elsewhere
  name = name.replace(/^(?:this|self)\./, "");
  if (name.length < 4) return null;
  if (/^[A-Z0-9_$]+$/.test(name)) return null; // constants / env vars
  if (SYMBOL_STOPWORDS.has(name.toLowerCase())) return null;
  if (!hasCall && !looksLikeCodeSymbol(name)) return null;
  return name;
}

const TABLE_PATTERNS: RegExp[] = [
  // Explicit DDL: any identifier is unambiguous here (schema prefix / quotes / IF EXISTS allowed).
  /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?"?(?:[A-Za-z_]\w*"?\.)?"?([A-Za-z_]\w*)"?/gi,
  // SQL clauses: uppercase keyword AND snake_case with an underscore, so prose
  // "from the" and column names like `id` do not register.
  /\b(?:FROM|JOIN)\s+"?(?:[a-z_]\w*"?\.)?"?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"?/g,
  /\btables?\s+`([a-z][a-z0-9_]*)`/gi,
  /`([a-z][a-z0-9_]*)`\s+table\b/gi,
  /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s+table\b/gi,
  /\.from\(\s*["']([A-Za-z_]\w*)["']\s*\)/g,
];

const ENV_PATTERNS: RegExp[] = [
  /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g,
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
];

function collect(re: RegExp, text: string, out: Set<string>, accept: (s: string) => boolean): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (accept(m[1])) out.add(m[1]);
  }
}

export function extractReferences(planContent: string): ExtractedReferences {
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const tables = new Set<string>();
  const envVars = new Set<string>();

  // Backticked spans carry the strongest signal, so they get the lenient path
  // rule and are the ONLY source of symbols.
  const backtickRe = /`([^`\n]{1,200})`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(planContent)) !== null) {
    const span = m[1];
    const norm = normalizePathToken(span);
    if (norm && isPathLike(norm, true)) {
      paths.add(norm);
      continue;
    }
    const sym = extractSymbolFromSpan(span);
    if (sym) symbols.add(sym);
  }

  // Markdown link targets and quoted strings behave like backticks for paths.
  const linkRe = /\]\(([^)\s]+)\)/g;
  while ((m = linkRe.exec(planContent)) !== null) {
    const norm = normalizePathToken(m[1]);
    if (norm && isPathLike(norm, true)) paths.add(norm);
  }
  const quoteRe = /["']([^"'\s`]{3,200})["']/g;
  while ((m = quoteRe.exec(planContent)) !== null) {
    const norm = normalizePathToken(m[1]);
    if (norm && isPathLike(norm, true)) paths.add(norm);
  }

  // Bare tokens: stricter (need a slash or a lowercase filename with a known extension).
  for (const token of planContent.split(/[\s`"'<>]+/)) {
    if (!token || (!token.includes("/") && !token.includes("."))) continue;
    const norm = normalizePathToken(token);
    if (norm && isPathLike(norm, false)) paths.add(norm);
  }

  for (const re of TABLE_PATTERNS) {
    collect(re, planContent, tables, (t) => t.length >= 2 && !SQL_KEYWORDS.has(t.toLowerCase()));
  }
  for (const re of ENV_PATTERNS) {
    collect(re, planContent, envVars, (e) => e.length >= 6 && e.includes("_"));
  }

  // A backticked `user_sessions` is a table when the prose says so; do not
  // double-count it as a symbol.
  for (const t of tables) symbols.delete(t);

  return {
    paths: [...paths],
    symbols: [...symbols],
    tables: [...tables],
    envVars: [...envVars],
  };
}

// ── Search backends ─────────────────────────────────────────────────────────

type GrepQuery =
  | { kind: "fixed"; text: string; word: boolean }
  | { kind: "regex"; ere: string; js: RegExp };

interface Searcher {
  /** Returns "path:line" hits (bounded), or null when the backend itself failed. */
  grep(q: GrepQuery, remainingMs: number): string[] | null;
}

// Docs are excluded from every grep: a symbol that only appears in a README (or
// in the plan itself, which is markdown) is not evidence that it exists in code.
const DOC_GLOBS = ["*.md", "*.mdx", "*.txt"];
const GREP_EXCLUDE_DIRS = ["node_modules", "drafts", "reviews", "dist", ".next", "build", "out", "coverage", "vendor"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseGrepLines(out: string): string[] {
  const hits: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^(.+?):(\d+):/.exec(line);
    if (!m) continue;
    const hit = `${m[1].replace(/\\/g, "/")}:${m[2]}`;
    if (!hits.includes(hit)) hits.push(hit);
    if (hits.length >= MAX_MATCHES) break;
  }
  return hits;
}

class GitSearcher implements Searcher {
  private readonly excludes: string[];

  constructor(private readonly root: string, planPath?: string) {
    this.excludes = [
      ...GREP_EXCLUDE_DIRS.map((d) => `:!${d}`),
      ":!*.lock",
      ...DOC_GLOBS.map((g) => `:!${g}`),
    ];
    if (planPath) this.excludes.push(`:!${planPath}`);
  }

  grep(q: GrepQuery, remainingMs: number): string[] | null {
    const args = ["-C", this.root, "grep", "-n", "-I", "--untracked", "--no-color"];
    if (q.kind === "fixed") {
      args.push("--fixed-strings");
      if (q.word) args.push("-w");
      args.push("-e", q.text);
    } else {
      args.push("-i", "-E", "-e", q.ere);
    }
    args.push("--", ...this.excludes);
    try {
      // execFileSync with an argv array: no shell, so plan-derived text is never interpolated.
      const out = execFileSync("git", args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: Math.max(500, remainingMs),
      });
      return parseGrepLines(out);
    } catch (err) {
      // Exit status 1 means "no matches"; anything else (128 = not a repo,
      // ENOENT = no git binary, timeouts) means the backend is unusable.
      const e = err as { status?: number | null; stdout?: string };
      if (e.status === 1) return [];
      return null;
    }
  }
}

class FsSearcher implements Searcher {
  private files: string[] | null = null;
  private readonly cache = new Map<string, string[]>();
  private indexedBytes = 0;

  constructor(private readonly root: string, private readonly planPath?: string) {}

  private listFiles(): string[] {
    if (this.files) return this.files;
    // walkRepo already skips SKIP_DIRS, binaries and >100 KB files; the extra
    // doc/plan filter mirrors the git backend so both give the same answers.
    this.files = walkRepo(this.root, 5000)
      .filter((f) => f.type === "file" && f.size <= MAX_FILE_BYTES)
      .map((f) => f.path)
      .filter((p) => p !== this.planPath && !DOC_GLOBS.some((g) => p.endsWith(g.slice(1))));
    return this.files;
  }

  private linesOf(rel: string): string[] {
    const cached = this.cache.get(rel);
    if (cached) return cached;
    if (this.indexedBytes > MAX_INDEX_BYTES) return [];
    try {
      const content = fs.readFileSync(path.join(this.root, rel), "utf8");
      this.indexedBytes += content.length;
      const lines = content.split("\n");
      this.cache.set(rel, lines);
      return lines;
    } catch {
      return [];
    }
  }

  grep(q: GrepQuery, remainingMs: number): string[] | null {
    const deadline = Date.now() + remainingMs;
    const re =
      q.kind === "regex"
        ? q.js
        : q.word
          ? new RegExp(`(^|[^\\w$])${escapeRegExp(q.text)}(?=[^\\w$]|$)`)
          : null;
    const hits: string[] = [];
    for (const rel of this.listFiles()) {
      if (Date.now() > deadline) return null;
      const lines = this.linesOf(rel);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const ok = re ? re.test(line) : line.includes((q as { text: string }).text);
        if (!ok) continue;
        hits.push(`${rel}:${i + 1}`);
        if (hits.length >= MAX_MATCHES) return hits;
        break; // one hit per file keeps the list diverse
      }
    }
    return hits;
  }
}

// ── Checking ────────────────────────────────────────────────────────────────

/** Case-sensitive existence check: `existsSync` lies on macOS/Windows filesystems. */
function statCaseSensitive(root: string, rel: string): "file" | "dir" | null {
  let cur = root;
  for (const seg of rel.split("/").filter(Boolean)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return null;
    }
    if (!entries.includes(seg)) return null;
    cur = path.join(cur, seg);
  }
  try {
    return fs.statSync(cur).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.local.example"];

function tableDefinitionQuery(name: string): Extract<GrepQuery, { kind: "regex" }> {
  // CREATE TABLE (with IF NOT EXISTS / schema prefix / quotes), Drizzle
  // pgTable("name") and Prisma @@map("name") all count as the table existing.
  const n = escapeRegExp(name);
  return {
    kind: "regex",
    ere: `create[[:space:]]+table[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?("?[a-z0-9_]+"?\\.)?"?${n}"?([^a-z0-9_]|$)|pgTable\\([[:space:]]*["']${n}["']|@@map\\([[:space:]]*["']${n}["']`,
    js: new RegExp(
      `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:"?[a-z0-9_]+"?\\.)?"?${n}"?(?![a-z0-9_])|pgTable\\(\\s*["']${n}["']|@@map\\(\\s*["']${n}["']`,
      "i"
    ),
  };
}

export function checkGroundTruth(planContent: string, repoRoot: string, opts: GroundTruthOptions = {}): GroundTruthReport {
  const started = Date.now();
  const maxRefs = opts.maxRefs ?? DEFAULT_MAX_REFS;
  const deadline = started + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const root = path.resolve(repoRoot);
  const extracted = extractReferences(planContent);

  // Paths and tables are the highest-value checks and the cheapest; symbols
  // are the noisiest, so they are the first to be cut by maxRefs.
  const queue: Array<{ kind: GroundTruthRef["kind"]; name: string }> = [
    ...extracted.paths.map((name) => ({ kind: "path" as const, name })),
    ...extracted.tables.map((name) => ({ kind: "table" as const, name })),
    ...extracted.envVars.map((name) => ({ kind: "env" as const, name })),
    ...extracted.symbols.map((name) => ({ kind: "symbol" as const, name })),
  ];

  let searcher: Searcher | null = null;
  let gitBroken = opts.backend === "fs";
  const remaining = () => deadline - Date.now();
  // Lazily pick the backend and demote git → fs the first time git fails.
  const grep = (q: GrepQuery): string[] | null => {
    if (remaining() <= 0) return null;
    if (!searcher) searcher = gitBroken ? new FsSearcher(root, opts.planPath) : new GitSearcher(root, opts.planPath);
    const hits = searcher.grep(q, remaining());
    if (hits !== null || gitBroken || opts.backend === "git") return hits;
    gitBroken = true;
    searcher = new FsSearcher(root, opts.planPath);
    return remaining() > 0 ? searcher.grep(q, remaining()) : null;
  };

  let tree: ReturnType<typeof walkRepo> | null = null;
  const basenameCandidates = (rel: string): string[] => {
    if (!tree) tree = walkRepo(root);
    const base = path.posix.basename(rel.replace(/\/$/, ""));
    const suffix = `/${rel.replace(/\/$/, "")}`;
    const files = tree.filter((f) => path.posix.basename(f.path) === base);
    // Prefer a longer suffix match (`lib/x.ts` → `src/lib/x.ts`) over a bare basename hit.
    files.sort((a, b) => Number(b.path.endsWith(suffix)) - Number(a.path.endsWith(suffix)));
    return files.slice(0, MAX_MATCHES).map((f) => f.path);
  };

  const refs: GroundTruthRef[] = [];
  const budgetExceeded = (kind: GroundTruthRef["kind"], name: string): GroundTruthRef => ({
    kind,
    name,
    status: "ambiguous",
    matches: [],
    note: "not checked (budget)",
  });

  queue.forEach((item, index) => {
    if (index >= maxRefs || remaining() <= 0) {
      refs.push(budgetExceeded(item.kind, item.name));
      return;
    }
    refs.push(checkOne(item.kind, item.name));
  });

  function checkOne(kind: GroundTruthRef["kind"], name: string): GroundTruthRef {
    switch (kind) {
      case "path": {
        const stat = statCaseSensitive(root, name);
        if (stat) return { kind, name, status: "found", matches: [name] };
        const candidates = basenameCandidates(name);
        if (candidates.length > 0) {
          return { kind, name, status: "ambiguous", matches: candidates, note: "not at that path; same filename found elsewhere" };
        }
        return { kind, name, status: "missing", matches: [] };
      }
      case "symbol": {
        const hits = grep({ kind: "fixed", text: name, word: true });
        if (hits === null) return budgetExceeded(kind, name);
        if (hits.length > 0) return { kind, name, status: "found", matches: hits };
        // `Class.method` is usually written as `instance.method` in code; a hit
        // on the bare method name is evidence, but only partial.
        const dot = name.lastIndexOf(".");
        if (dot > 0) {
          const member = name.slice(dot + 1);
          const partial = member.length >= 4 ? grep({ kind: "fixed", text: member, word: true }) : [];
          if (partial === null) return budgetExceeded(kind, name);
          if (partial.length > 0) {
            return { kind, name, status: "ambiguous", matches: partial, note: `\`${member}\` exists but not as \`${name}\`` };
          }
        }
        return { kind, name, status: "missing", matches: [] };
      }
      case "table": {
        const query = tableDefinitionQuery(name);
        const createdHere = query.js.test(planContent);
        const hits = grep(query);
        if (hits === null) {
          return createdHere
            ? { kind, name, status: "found", matches: [], note: "created by this plan" }
            : budgetExceeded(kind, name);
        }
        if (createdHere) {
          // A plan that creates a table which already exists is itself a finding
          // worth surfacing, so keep both facts.
          const note = hits.length > 0 ? "created by this plan — but a definition already exists in the repo" : "created by this plan";
          return { kind, name, status: "found", matches: hits, note };
        }
        if (hits.length > 0) return { kind, name, status: "found", matches: hits };
        return { kind, name, status: "missing", matches: [] };
      }
      case "env": {
        // .env.example files are blocked by walkRepo (they end in .env-ish
        // names) and may be untracked, so read them directly.
        const exampleHits: string[] = [];
        for (const file of ENV_EXAMPLE_FILES) {
          const full = path.join(root, file);
          let content: string;
          try {
            if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
            content = fs.readFileSync(full, "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          const idx = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=`).test(l));
          if (idx >= 0) exampleHits.push(`${file}:${idx + 1}`);
        }
        const hits = grep({ kind: "fixed", text: name, word: true });
        if (hits === null && exampleHits.length === 0) return budgetExceeded(kind, name);
        // git grep also sees a tracked .env.example, so dedupe against the direct read.
        const matches = [...new Set([...exampleHits, ...(hits ?? [])])].slice(0, MAX_MATCHES);
        if (matches.length > 0) return { kind, name, status: "found", matches };
        return { kind, name, status: "missing", matches: [] };
      }
    }
  }

  return {
    refs,
    found: refs.filter((r) => r.status === "found").length,
    missing: refs.filter((r) => r.status === "missing").length,
    ambiguous: refs.filter((r) => r.status === "ambiguous").length,
    durationMs: Date.now() - started,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderRef(r: GroundTruthRef): string {
  const parts = [`- ${r.kind} \`${r.name}\``];
  if (r.matches.length > 0) parts.push(`→ ${r.matches.join(", ")}`);
  if (r.note) parts.push(`(${r.note})`);
  return parts.join(" ");
}

/**
 * Renders the report as a prompt block. Returns "" when nothing was referenced
 * so callers can append it unconditionally.
 */
export function renderFactsBlock(report: GroundTruthReport): string {
  if (report.refs.length === 0) return "";
  const found = report.refs.filter((r) => r.status === "found");
  const missing = report.refs.filter((r) => r.status === "missing");
  const ambiguous = report.refs.filter((r) => r.status === "ambiguous");

  const lines: string[] = [
    "<verified_facts>",
    `Pre-checked against the actual repository (${report.found} found, ${report.missing} missing, ${report.ambiguous} ambiguous). ` +
      "These are mechanical lookups, not model output.",
  ];
  if (found.length > 0) {
    lines.push("", "FOUND (exists in the repo):", ...found.map(renderRef));
  }
  if (missing.length > 0) {
    lines.push("", "MISSING (does NOT exist anywhere in the repo):", ...missing.map(renderRef));
  }
  if (ambiguous.length > 0) {
    lines.push("", "AMBIGUOUS (could not be confirmed either way):", ...ambiguous.map(renderRef));
  }
  lines.push(
    "",
    "Instruction: treat MISSING as ground truth — the file, symbol, table or env var does not exist yet. " +
      "Say so explicitly instead of assuming it exists or reasoning about its contents; never invent paths, " +
      "and only cite paths that are FOUND or present in the provided context.",
    "</verified_facts>"
  );
  return lines.join("\n");
}

// ── Finding integrity ───────────────────────────────────────────────────────

/**
 * Flags findings whose location or claim names something the report proved
 * missing. Untouched findings are returned as-is (no `unverified: false`) so
 * legacy output stays byte-stable.
 */
export function markUnverifiedFindings<T extends { claim: string; location?: string; evidence?: string }>(
  findings: T[],
  report: GroundTruthReport
): Array<T & { unverified?: boolean }> {
  const missing = report.refs.filter((r) => r.status === "missing");
  if (missing.length === 0) return findings;
  return findings.map((f) => {
    const haystack = `${f.location ?? ""}\n${f.claim}`;
    const hit = missing.some((r) =>
      r.kind === "path"
        ? haystack.includes(r.name)
        : new RegExp(`(^|[^\\w$])${escapeRegExp(r.name)}(?=[^\\w$]|$)`).test(haystack)
    );
    return hit ? { ...f, unverified: true } : f;
  });
}
