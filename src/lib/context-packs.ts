import { ContextPack, RepoFile } from "./types";
import { estimateTokens } from "./model-registry";

// --- localStorage CRUD (metadata only) ---

const PACKS_KEY = "context-packs";
const ACTIVE_KEY = "active-context-pack";

interface PackStore {
  version: 1;
  packs: ContextPack[];
}

export function migrateStore(raw: unknown): ContextPack[] {
  if (!raw) return [];
  // Handle raw array (pre-versioning)
  if (Array.isArray(raw)) {
    return raw.map((item) => migratePack(item as unknown as Record<string, unknown>));
  }
  // Handle versioned store
  const store = raw as Partial<PackStore>;
  if (store.version === 1 && Array.isArray(store.packs)) {
    return store.packs.map((item) => migratePack(item as unknown as Record<string, unknown>));
  }
  return [];
}

function migratePack(raw: Record<string, unknown>): ContextPack {
  return {
    version: 1,
    id: (raw.id as string) || `pack_${Date.now()}`,
    name: (raw.name as string) || "Unnamed Pack",
    repo: (raw.repo as string) || "",
    branch: (raw.branch as string) || "main",
    brief: (raw.brief as string) || "",
    briefEnhanced: (raw.briefEnhanced as boolean) ?? false,
    selectedFiles: Array.isArray(raw.selectedFiles) ? raw.selectedFiles : [],
    createdAt: (raw.createdAt as string) || new Date().toISOString(),
    updatedAt: (raw.updatedAt as string) || new Date().toISOString(),
  };
}

export function getContextPacks(): ContextPack[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(PACKS_KEY) || "null");
    return migrateStore(raw);
  } catch {
    return [];
  }
}

export function saveContextPack(pack: ContextPack): void {
  const packs = getContextPacks();
  const idx = packs.findIndex((p) => p.id === pack.id);
  if (idx >= 0) {
    packs[idx] = { ...pack, updatedAt: new Date().toISOString() };
  } else {
    packs.push(pack);
  }
  try {
    const store: PackStore = { version: 1, packs };
    localStorage.setItem(PACKS_KEY, JSON.stringify(store));
  } catch (err) {
    if (err instanceof DOMException && err.name === "QuotaExceededError") {
      throw new Error("Storage full — remove some packs to free space");
    }
    throw err;
  }
}

export function deleteContextPack(id: string): void {
  const packs = getContextPacks().filter((p) => p.id !== id);
  const store: PackStore = { version: 1, packs };
  localStorage.setItem(PACKS_KEY, JSON.stringify(store));
  // Clear active if this was active
  if (getActivePackId() === id) setActivePackId(null);
}

export function getActivePackId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY) || null;
}

export function setActivePackId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

// --- Export / Import ---

export function exportPack(pack: ContextPack): string {
  // Export metadata only — no file contents
  return JSON.stringify(pack, null, 2);
}

export function importPack(json: string): ContextPack {
  const raw = JSON.parse(json);
  if (!raw || typeof raw !== "object") throw new Error("Invalid pack format");
  const pack = migratePack(raw);
  // Assign new ID to avoid collisions
  pack.id = `pack_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pack.createdAt = new Date().toISOString();
  pack.updatedAt = new Date().toISOString();
  return pack;
}

// --- Template brief generation ---

interface PkgJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const STACK_DETECT: Array<{ dep: string; name: string }> = [
  { dep: "next", name: "Next.js" },
  { dep: "react", name: "React" },
  { dep: "vue", name: "Vue" },
  { dep: "nuxt", name: "Nuxt" },
  { dep: "svelte", name: "Svelte" },
  { dep: "@angular/core", name: "Angular" },
  { dep: "express", name: "Express" },
  { dep: "fastify", name: "Fastify" },
  { dep: "hono", name: "Hono" },
  { dep: "prisma", name: "Prisma" },
  { dep: "@prisma/client", name: "Prisma" },
  { dep: "drizzle-orm", name: "Drizzle ORM" },
  { dep: "mongoose", name: "Mongoose" },
  { dep: "@neondatabase/serverless", name: "Neon PostgreSQL" },
  { dep: "tailwindcss", name: "TailwindCSS" },
  { dep: "@clerk/nextjs", name: "Clerk Auth" },
  { dep: "next-auth", name: "NextAuth" },
  { dep: "@supabase/supabase-js", name: "Supabase" },
  { dep: "firebase", name: "Firebase" },
  { dep: "stripe", name: "Stripe" },
  { dep: "zod", name: "Zod" },
  { dep: "trpc", name: "tRPC" },
  { dep: "@trpc/server", name: "tRPC" },
  { dep: "ai", name: "Vercel AI SDK" },
  { dep: "@anthropic-ai/sdk", name: "Anthropic SDK" },
  { dep: "openai", name: "OpenAI SDK" },
];

function detectStack(pkg: PkgJson): string[] {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const seen = new Set<string>();
  const stack: string[] = [];

  for (const { dep, name } of STACK_DETECT) {
    if (allDeps[dep] && !seen.has(name)) {
      seen.add(name);
      const version = allDeps[dep].replace(/[\^~>=<]/g, "").split(".")[0];
      stack.push(version ? `${name} ${version}` : name);
    }
  }
  return stack;
}

function buildFileTreeSummary(files: RepoFile[]): string {
  // Group by top-level directories, show 3 levels deep
  const dirs = new Map<string, number>();
  const topFiles: string[] = [];

  for (const f of files) {
    const parts = f.path.split("/");
    if (parts.length === 1 && f.type === "file") {
      topFiles.push(f.path);
    } else if (parts.length >= 1) {
      // Count files per top-2-level directory
      const key = parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0];
      dirs.set(key, (dirs.get(key) || 0) + 1);
    }
  }

  const lines: string[] = [];
  // Sort directories by file count descending
  const sorted = [...dirs.entries()].sort((a, b) => b[1] - a[1]);
  for (const [dir, count] of sorted.slice(0, 15)) {
    lines.push(`${dir.padEnd(30)} (${count} files)`);
  }
  if (topFiles.length > 0) {
    for (const f of topFiles.slice(0, 10)) {
      lines.push(f);
    }
  }
  return lines.join("\n");
}

const KEY_FILE_PATTERNS = [
  /^prisma\/schema\.prisma$/,
  /^schema\.prisma$/,
  /^drizzle\.config\./,
  /layout\.(tsx?|jsx?)$/,
  /^(next|nuxt|svelte|vite|astro)\.config\./,
  /^tsconfig\.json$/,
  /^package\.json$/,
  /^README\.md$/i,
  /^(middleware|auth)\.(ts|js)$/,
  /\/middleware\.(ts|js)$/,
];

function detectKeyFilesFromTree(files: RepoFile[]): string[] {
  const keyFiles: string[] = [];
  for (const f of files) {
    if (f.type !== "file") continue;
    if (KEY_FILE_PATTERNS.some((p) => p.test(f.path))) {
      keyFiles.push(f.path);
    }
  }
  return keyFiles.slice(0, 10);
}

const PATTERN_INDICATORS: Array<{ test: (files: RepoFile[]) => boolean; label: string }> = [
  { test: (fs) => fs.some((f) => f.path.includes("/app/") && f.path.endsWith("page.tsx")), label: "App Router (Next.js app/ directory)" },
  { test: (fs) => fs.some((f) => f.path.includes("/pages/") && f.path.endsWith(".tsx")), label: "Pages Router (Next.js pages/ directory)" },
  { test: (fs) => fs.some((f) => f.path.includes("/api/") && f.path.endsWith("route.ts")), label: "API Routes (route handlers)" },
  { test: (fs) => fs.some((f) => f.path.endsWith("schema.prisma")), label: "Prisma ORM (schema-driven database)" },
  { test: (fs) => fs.some((f) => f.path.includes("middleware.ts") || f.path.includes("middleware.js")), label: "Middleware layer" },
  { test: (fs) => fs.some((f) => f.path.includes("/components/")), label: "Component library (shared components)" },
  { test: (fs) => fs.some((f) => f.path.includes("/lib/") || f.path.includes("/utils/")), label: "Utility layer (lib/ or utils/)" },
  { test: (fs) => fs.some((f) => f.path.includes("docker") || f.path.includes("Dockerfile")), label: "Docker containerization" },
  { test: (fs) => fs.some((f) => f.path.includes(".github/workflows")), label: "GitHub Actions CI/CD" },
];

export function generateTemplateBrief(
  repo: string,
  branch: string,
  tree: RepoFile[],
  packageJson?: PkgJson
): string {
  const projectName = repo.split("/").pop() || repo;
  const stack = packageJson ? detectStack(packageJson) : [];
  const fileTree = buildFileTreeSummary(tree);
  const keyFiles = detectKeyFilesFromTree(tree);
  const patterns = PATTERN_INDICATORS.filter((p) => p.test(tree)).map((p) => p.label);

  const lines: string[] = [
    `PROJECT: ${projectName}`,
    `REPO: ${repo} (branch: ${branch})`,
  ];

  if (stack.length > 0) {
    lines.push(`STACK: ${stack.join(", ")}`);
  }

  lines.push("");
  lines.push("FILE STRUCTURE:");
  lines.push(fileTree);

  if (keyFiles.length > 0) {
    lines.push("");
    lines.push("KEY FILES:");
    for (const f of keyFiles) {
      lines.push(`- ${f}`);
    }
  }

  if (patterns.length > 0) {
    lines.push("");
    lines.push("DETECTED PATTERNS:");
    for (const p of patterns) {
      lines.push(`- ${p}`);
    }
  }

  lines.push("");
  lines.push(`Total: ${tree.filter((f) => f.type === "file").length} files`);

  return lines.join("\n");
}

// --- AI brief enhancement ---

const ENHANCE_PROMPT = `You are analyzing a codebase to produce a structured architectural summary for use as context when AI models review plans and documents about this project.

You will receive:
1. A template brief with basic file structure and stack info
2. Contents of key files from the repository

Produce a concise (under 1500 words) architectural summary covering:
- **Project purpose and domain** (what this app does, who it's for)
- **Stack** with version details
- **Architecture patterns** (data fetching, auth, routing, state management, rendering strategy)
- **Data model** (key entities and relationships, from schema if available)
- **Key subsystems** and how they interact
- **API surface** (public vs protected routes, external integrations)
- **Current state** (what looks active/recent vs stable/legacy)

Format as plain text with clear section headers. Be specific — name actual files, patterns, and relationships you observe. Skip anything you can't determine from the provided files.

Do NOT include instructions, caveats, or meta-commentary. Just the summary.`;

export async function enhanceBrief(
  anthropicKey: string,
  templateBrief: string,
  keyFileContents: Record<string, string>
): Promise<string> {
  const fileSection = Object.entries(keyFileContents)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``)
    .join("\n\n");

  const userMessage = `TEMPLATE BRIEF:\n${templateBrief}\n\nKEY FILE CONTENTS:\n${fileSection}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        { role: "user", content: userMessage },
      ],
      system: ENHANCE_PROMPT,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Enhancement failed: ${res.status} ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("No text returned from enhancement model");
  }

  return textBlock.text;
}

// --- Key file detection for AI enhancement ---

export function detectKeyFiles(tree: RepoFile[]): string[] {
  const priorities: Array<{ pattern: RegExp; priority: number }> = [
    { pattern: /^package\.json$/, priority: 1 },
    { pattern: /schema\.prisma$/, priority: 2 },
    { pattern: /drizzle\.config\./, priority: 2 },
    { pattern: /layout\.(tsx?|jsx?)$/, priority: 3 },
    { pattern: /^(next|nuxt|svelte|vite|astro)\.config\./, priority: 4 },
    { pattern: /^tsconfig\.json$/, priority: 5 },
    { pattern: /^(middleware|auth)\.(ts|js)$/, priority: 6 },
    { pattern: /\/middleware\.(ts|js)$/, priority: 6 },
    { pattern: /\/route\.(ts|js)$/, priority: 7 }, // API routes
    { pattern: /^README\.md$/i, priority: 8 },
    { pattern: /\/db\.(ts|js)$/, priority: 6 },
    { pattern: /\/types\.(ts|d\.ts)$/, priority: 7 },
  ];

  const candidates: Array<{ path: string; priority: number }> = [];

  for (const f of tree) {
    if (f.type !== "file") continue;
    if (f.size > 50_000) continue; // Skip large files

    for (const { pattern, priority } of priorities) {
      if (pattern.test(f.path)) {
        candidates.push({ path: f.path, priority });
        break; // First match wins for this file
      }
    }
  }

  // Sort by priority, take top 10
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.slice(0, 10).map((c) => c.path);
}

// --- Auto-detect file references in pasted content ---

export function detectReferencedFiles(content: string, tree: RepoFile[]): string[] {
  if (!content || tree.length === 0) return [];

  const treePaths = new Set(tree.filter((f) => f.type === "file").map((f) => f.path));
  const found = new Set<string>();

  // Match file-path-like patterns in the content
  // Patterns: src/..., app/..., lib/..., prisma/..., components/...
  const pathRegex = /(?:^|[\s"'`(,])(((?:src|app|lib|prisma|components|pages|public|api|utils|hooks|services|config|test|tests|scripts|styles|assets)\/)[^\s"'`),;:]+\.[a-zA-Z]{1,6})/gm;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(content)) !== null) {
    const candidate = match[1].trim();
    if (treePaths.has(candidate)) {
      found.add(candidate);
    }
  }

  // Also try relative paths like ./foo.ts or ../foo.ts
  const relRegex = /(?:^|[\s"'`(])\.\.?\/([^\s"'`),;:]+\.[a-zA-Z]{1,6})/gm;
  while ((match = relRegex.exec(content)) !== null) {
    const candidate = match[1].trim();
    // Try to find it anywhere in the tree
    for (const tp of treePaths) {
      if (tp.endsWith(candidate) || tp.endsWith("/" + candidate)) {
        found.add(tp);
        break;
      }
    }
  }

  return [...found].slice(0, 20);
}

// --- Prompt construction ---

export function buildContextString(
  pack: ContextPack,
  fileContents: Record<string, string>
): string {
  if (!pack.brief && pack.selectedFiles.length === 0) return "";

  const parts: string[] = [];

  if (pack.brief) {
    parts.push(pack.brief);
  }

  const filePaths = pack.selectedFiles.filter((p) => fileContents[p]);
  if (filePaths.length > 0) {
    parts.push("");
    parts.push("ATTACHED FILES:");
    for (const path of filePaths) {
      const content = fileContents[path];
      const ext = path.split(".").pop() || "";
      parts.push(`\n### ${path}`);
      parts.push("```" + ext);
      parts.push(content);
      parts.push("```");
    }
  }

  return parts.join("\n");
}

// --- Token estimation for context ---

export function estimateContextTokens(pack: ContextPack, fileContents: Record<string, string>): number {
  const contextString = buildContextString(pack, fileContents);
  if (!contextString) return 0;
  // Use code-aware estimation (2.5 chars/token) with 20% buffer + overhead
  return Math.ceil(contextString.length / 2.5 * 1.2) + 200;
}
