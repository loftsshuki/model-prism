/**
 * Local filesystem context builder — for CLI use.
 *
 * Mirrors the shape of `context-packs.ts` but reads files directly from disk
 * instead of hitting the GitHub API. Used by the review-plan CLI.
 */
import * as fs from "fs";
import * as path from "path";
import { RepoFile } from "./types";
import { generateTemplateBrief, detectKeyFiles, enhanceBrief } from "./context-packs";

// --- Filesystem walking ---

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", ".vercel",
  ".cache", "coverage", "__pycache__", ".turbo",
  "build", "out", ".nuxt", ".output",
  ".svelte-kit", "vendor", "target",
  // Plan review outputs — exclude to prevent context feedback loops
  "drafts", "reviews",
]);

const BLOCKED_FILE_EXTS = [".env", ".pem", ".key", ".secret", ".p12", ".pfx"];
const BLOCKED_NAMES = ["credentials", ".npmrc", ".pypirc", "serviceaccount.json"];

// Skip binary / non-useful file types to keep context lean
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
  ".mp4", ".mov", ".avi", ".webm", ".mp3", ".wav", ".flac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".exe", ".dll", ".so", ".dylib", ".bin",
  ".zip", ".tar", ".gz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".lock", // package-lock, bun.lock — too large, not useful for context
]);

const MAX_FILE_SIZE = 100_000; // 100KB cap per file

export function walkRepo(rootDir: string, maxFiles = 2000): RepoFile[] {
  const files: RepoFile[] = [];

  function walk(dir: string, relativeTo: string) {
    if (files.length >= maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        files.push({ path: relPath, size: 0, type: "dir" });
        walk(fullPath, relativeTo);
      } else if (entry.isFile()) {
        // Skip blocked / secret-bearing files
        const lower = entry.name.toLowerCase();
        if (BLOCKED_NAMES.some((n) => lower === n || lower.startsWith(n))) continue;
        if (BLOCKED_FILE_EXTS.some((ext) => lower.endsWith(ext) || lower.includes(ext + "."))) continue;
        // Skip binary and non-text file extensions
        const extMatch = lower.match(/\.[a-z0-9]+$/);
        if (extMatch && SKIP_EXTENSIONS.has(extMatch[0])) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue; // Skip files too large for context
          files.push({ path: relPath, size: stat.size, type: "file" });
        } catch { /* skip */ }
      }
    }
  }

  walk(rootDir, rootDir);
  return files;
}

// --- Find repo root from any file path (walks up looking for package.json or .git) ---

export function findRepoRoot(startPath: string): string {
  let current = path.resolve(startPath);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }

  // .git dir is the strongest signal for the TRUE repo root (monorepo-aware)
  let gitRoot: string | null = null;
  let pkgRoot: string | null = null;

  let walker = current;
  while (walker !== path.dirname(walker)) {
    if (!gitRoot && fs.existsSync(path.join(walker, ".git"))) {
      gitRoot = walker;
    }
    if (!pkgRoot && fs.existsSync(path.join(walker, "package.json"))) {
      pkgRoot = walker;
    }
    walker = path.dirname(walker);
  }

  // .git wins for monorepo correctness — prevents stopping at a sub-package's package.json
  if (gitRoot) return gitRoot;
  if (pkgRoot) return pkgRoot;
  return path.resolve(startPath);
}

// --- Read package.json if present ---

export function readPackageJson(repoRoot: string): object | undefined {
  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return undefined;
  }
}

// --- Read a file from disk ---

export function readLocalFile(repoRoot: string, relativePath: string): string | null {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > 500_000) return null;
    return fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}

// --- Build local context for a repo ---

export interface LocalContext {
  repoRoot: string;
  repoName: string;
  tree: RepoFile[];
  brief: string;
  keyFiles: Record<string, string>;
}

export async function buildLocalContext(
  repoRoot: string,
  options: { enhance?: boolean; anthropicKey?: string } = {}
): Promise<LocalContext> {
  const repoName = path.basename(repoRoot);
  const tree = walkRepo(repoRoot);
  const pkg = readPackageJson(repoRoot);

  // Generate template brief
  let brief = generateTemplateBrief(repoName, "local", tree, pkg);

  // Load key file contents
  const keyFilePaths = detectKeyFiles(tree);
  const keyFiles: Record<string, string> = {};
  for (const relPath of keyFilePaths) {
    const content = readLocalFile(repoRoot, relPath);
    if (content !== null) {
      keyFiles[relPath] = content;
    }
  }

  // Optional AI enhancement
  if (options.enhance && options.anthropicKey) {
    try {
      brief = await enhanceBrief(options.anthropicKey, brief, keyFiles);
    } catch (err) {
      console.warn(`Brief enhancement failed: ${(err as Error).message}. Using template brief.`);
    }
  }

  return { repoRoot, repoName, tree, brief, keyFiles };
}

// --- Secret scrubbing ---

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/((?:api[_-]?key|secret|token|password|auth)\s*[=:]\s*["'])[^"']{8,}(["'])/gi, "$1[REDACTED]$2"],
  [/(sk-[a-zA-Z0-9]{20,})/g, "[REDACTED-API-KEY]"],
  [/(ghp_[a-zA-Z0-9]{36})/g, "[REDACTED-GITHUB-PAT]"],
  [/(github_pat_[a-zA-Z0-9_]{22,})/g, "[REDACTED-GITHUB-PAT]"],
  [/(AKIA[A-Z0-9]{16})/g, "[REDACTED-AWS-KEY]"],
  [/-----BEGIN\s+[A-Z\s]*?PRIVATE KEY-----[\s\S]*?-----END\s+[A-Z\s]*?PRIVATE KEY-----/g, "[REDACTED-PRIVATE-KEY]"],
  [/(Bearer\s+[a-zA-Z0-9._\-]{20,})/g, "Bearer [REDACTED]"],
];

export function scrubSecrets(text: string): { scrubbed: string; count: number } {
  let count = 0;
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const matches = result.match(pattern);
    if (matches) count += matches.length;
    result = result.replace(pattern, replacement);
  }
  return { scrubbed: result, count };
}

// --- Build final context string for injection into prompts ---

const MAX_CONTEXT_CHARS = 80_000; // ~20k tokens — fits smallest free model windows

export function buildLocalContextString(
  ctx: LocalContext,
  attachedFiles: string[] = []
): string {
  const parts: string[] = [ctx.brief];

  if (attachedFiles.length > 0) {
    parts.push("\nATTACHED FILES:\n");
    for (const relPath of attachedFiles) {
      const content = readLocalFile(ctx.repoRoot, relPath);
      if (content === null) continue;
      const ext = relPath.split(".").pop() || "";
      parts.push(`\n### ${relPath}`);
      parts.push("```" + ext);
      parts.push(content);
      parts.push("```");
    }
  }

  const joined = parts.join("\n");
  const { scrubbed, count: scrubbedCount } = scrubSecrets(joined);

  // Size guard — truncate if context balloons beyond model limits
  if (scrubbed.length > MAX_CONTEXT_CHARS) {
    const truncated =
      scrubbed.slice(0, MAX_CONTEXT_CHARS) +
      `\n\n[CONTEXT TRUNCATED: exceeded ${MAX_CONTEXT_CHARS} chars, original length ${scrubbed.length}]`;
    if (scrubbedCount > 0) {
      console.warn(`[local-context] scrubbed ${scrubbedCount} secret pattern(s) from context`);
    }
    return truncated;
  }

  if (scrubbedCount > 0) {
    console.warn(`[local-context] scrubbed ${scrubbedCount} secret pattern(s) from context`);
  }
  return scrubbed;
}
