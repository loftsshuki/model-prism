import { RepoFile } from "./types";

export interface ContextPackTemplate {
  id: string;
  name: string;
  description: string;
  briefNote: string;
  maxFiles: number;
  patterns: RegExp[];
}

export const CONTEXT_PACK_TEMPLATES: ContextPackTemplate[] = [
  {
    id: "nextjs-app",
    name: "Next.js App",
    description: "Routes, layouts, config, auth middleware, core lib, and package metadata.",
    maxFiles: 24,
    briefNote: "Review focus: Next.js routing/rendering, API boundaries, shared UI, middleware, and app-level conventions.",
    patterns: [
      /^package\.json$/,
      /^next\.config\./,
      /^tsconfig\.json$/,
      /^src\/app\/layout\.(tsx|jsx)$/,
      /^src\/app\/page\.(tsx|jsx)$/,
      /^src\/app\/.*\/layout\.(tsx|jsx)$/,
      /^src\/app\/.*\/page\.(tsx|jsx)$/,
      /^src\/app\/api\/.*\/route\.(ts|js)$/,
      /^src\/middleware\.(ts|js)$/,
      /^middleware\.(ts|js)$/,
      /^src\/lib\/(auth|db|utils|config|supabase|server|client)[^/]*\.(ts|js)$/,
      /^src\/components\/(layout|ui|nav|navigation|sidebar)[^/]*\.(tsx|jsx|ts|js)$/,
      /^AGENTS\.md$/i,
      /^README\.md$/i,
    ],
  },
  {
    id: "supabase-backend",
    name: "Supabase Backend",
    description: "Supabase clients, migrations, schema/types, auth helpers, and API routes.",
    maxFiles: 24,
    briefNote: "Review focus: Supabase auth, RLS/data access boundaries, schema drift, server/client separation, and migrations.",
    patterns: [
      /^package\.json$/,
      /^supabase\/config\.toml$/,
      /^supabase\/migrations\/.*\.sql$/,
      /^supabase\/functions\/.*\.(ts|js)$/,
      /^database\/.*\.sql$/,
      /^src\/lib\/supabase[^/]*\.(ts|js)$/,
      /^src\/lib\/(db|database|auth|server|client)[^/]*\.(ts|js)$/,
      /^src\/types\/supabase\.(ts|d\.ts)$/,
      /^src\/app\/api\/.*\/route\.(ts|js)$/,
      /^AGENTS\.md$/i,
      /^README\.md$/i,
    ],
  },
  {
    id: "ai-infra",
    name: "AI Infra / Tooling",
    description: "Agent rules, scripts, hooks, model configs, prompts, and AI API integrations.",
    maxFiles: 28,
    briefNote: "Review focus: AI workflow safety, tool permissions, model routing, prompt design, retries/fallbacks, and automation blast radius.",
    patterns: [
      /^package\.json$/,
      /^AGENTS\.md$/i,
      /^CLAUDE\.md$/i,
      /^README\.md$/i,
      /^\.claude\/.*\.(json|md)$/,
      /^scripts\/ai\/.*\.(ts|js|sh|json|md)$/,
      /^scripts\/(spec|audit|sentry|session|review|model|ai).*\/(package\.json|.*\.(ts|js|md|json|sh))$/,
      /^src\/lib\/(ai|models|model|synthesis|fan-out|prompts|rosters|telemetry|api-auth)[^/]*\.(ts|js)$/,
      /^src\/app\/api\/(invoke|models|synthesize|telemetry|review).*\/route\.(ts|js)$/,
      /^distributed-agents\/.*\.(json|js|ts|md)$/,
    ],
  },
  {
    id: "marketing-site",
    name: "Marketing / Content Site",
    description: "Homepage, layout, content, design tokens, shared sections, SEO config.",
    maxFiles: 22,
    briefNote: "Review focus: positioning clarity, content hierarchy, accessibility, SEO metadata, conversion paths, and visual consistency.",
    patterns: [
      /^package\.json$/,
      /^src\/app\/layout\.(tsx|jsx)$/,
      /^src\/app\/page\.(tsx|jsx)$/,
      /^src\/app\/(about|pricing|contact|blog|features).*\/(page|layout)\.(tsx|jsx)$/,
      /^src\/components\/(hero|marketing|sections|footer|header|nav|pricing|cta)[^/]*\.(tsx|jsx|ts|js)$/i,
      /^src\/content\/.*\.(md|mdx|json)$/,
      /^tailwind\.config\./,
      /^src\/app\/globals\.css$/,
      /^README\.md$/i,
    ],
  },
  {
    id: "security-review",
    name: "Security Review",
    description: "Auth, middleware, API routes, env examples, data access, package metadata.",
    maxFiles: 30,
    briefNote: "Review focus: authN/authZ, secrets, unsafe APIs, data exposure, dependency risk, RLS/server boundaries, and destructive automation.",
    patterns: [
      /^package\.json$/,
      /^\.env\.example$/,
      /^src\/middleware\.(ts|js)$/,
      /^middleware\.(ts|js)$/,
      /^src\/lib\/(auth|api-auth|session|permissions|rbac|db|database|supabase|server)[^/]*\.(ts|js)$/,
      /^src\/app\/api\/.*\/route\.(ts|js)$/,
      /^supabase\/migrations\/.*\.sql$/,
      /^prisma\/schema\.prisma$/,
      /^scripts\/.*\.(sh|ps1|ts|js)$/,
      /^AGENTS\.md$/i,
      /^README\.md$/i,
    ],
  },
  {
    id: "pr-review",
    name: "PR Review",
    description: "Core repo instructions, package metadata, tests, affected route/API/lib patterns.",
    maxFiles: 24,
    briefNote: "Review focus: changed-file impact, test coverage, regression risk, rollout risk, and concrete review comments.",
    patterns: [
      /^package\.json$/,
      /^AGENTS\.md$/i,
      /^CLAUDE\.md$/i,
      /^README\.md$/i,
      /^src\/app\/.*\/(page|layout|route)\.(tsx|jsx|ts|js)$/,
      /^src\/lib\/.*\.(ts|js)$/,
      /^src\/components\/.*\.(tsx|jsx)$/,
      /\.(test|spec)\.(ts|tsx|js|jsx)$/,
      /^tests\/.*\.(ts|tsx|js)$/,
      /^\.github\/workflows\/.*\.ya?ml$/,
    ],
  },
];

export function suggestFilesForContextTemplate(templateId: string, files: RepoFile[]): string[] {
  const template = CONTEXT_PACK_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return [];

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const pattern of template.patterns) {
    for (const file of files) {
      if (file.type !== "file" || seen.has(file.path) || file.size > 500_000) continue;
      if (!pattern.test(file.path)) continue;
      selected.push(file.path);
      seen.add(file.path);
      if (selected.length >= template.maxFiles) return selected;
    }
  }

  return selected;
}

export function getContextTemplate(templateId: string): ContextPackTemplate | undefined {
  return CONTEXT_PACK_TEMPLATES.find((item) => item.id === templateId);
}
