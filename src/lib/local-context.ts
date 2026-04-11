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
]);

const BLOCKED_FILE_EXTS = [".env", ".pem", ".key", ".secret"];
const BLOCKED_NAMES = ["credentials", ".npmrc", ".pypirc"];

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
        // Skip blocked files
        const lower = entry.name.toLowerCase();
        if (BLOCKED_NAMES.some((n) => lower === n || lower.startsWith(n))) continue;
        if (BLOCKED_FILE_EXTS.some((ext) => lower.endsWith(ext))) continue;

        try {
          const stat = fs.statSync(fullPath);
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
  if (fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }

  while (current !== path.dirname(current)) {
    if (
      fs.existsSync(path.join(current, "package.json")) ||
      fs.existsSync(path.join(current, ".git"))
    ) {
      return current;
    }
    current = path.dirname(current);
  }

  // Fallback to start path
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

// --- Build final context string for injection into prompts ---

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

  return parts.join("\n");
}
