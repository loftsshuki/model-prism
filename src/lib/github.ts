import pLimit from "p-limit";
import {
  GitHubRepo,
  RepoFile,
  FetchTreeResult,
  FileFetchResult,
  PatValidationResult,
  GitHubApiError,
  RateLimitInfo,
} from "./types";

const API_BASE = "https://api.github.com";
const ghLimit = pLimit(3); // Max 3 concurrent GitHub requests

// --- Rate limit tracking ---

let rateLimitInfo: RateLimitInfo | null = null;

export function getRateLimitInfo(): RateLimitInfo | null {
  return rateLimitInfo;
}

// --- Request deduplication ---

const inflightRequests = new Map<string, Promise<Response>>();

// --- Blocked / allowed files ---

const BLOCKED_EXTENSIONS = [
  ".env", ".env.local", ".env.production", ".env.development", ".env.staging", ".env.test",
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
  ".secret",
];

const BLOCKED_NAMES = [
  "credentials", "credentials.json", "serviceaccount.json",
  "service-account.json", ".npmrc", ".pypirc",
];

const ALLOWED_EXTENSIONS = new Set([
  ".json", ".js", ".ts", ".jsx", ".tsx", ".md", ".txt",
  ".prisma", ".graphql", ".gql", ".sql",
  ".py", ".rb", ".go", ".java", ".cpp", ".h", ".cs", ".php", ".rs",
  ".yaml", ".yml", ".toml", ".cfg", ".ini", ".conf",
  ".css", ".scss", ".less", ".html", ".svg", ".xml",
  ".sh", ".bash", ".zsh", ".fish",
  ".dockerfile", ".dockerignore", ".gitignore",
  ".lock", // package-lock.json, yarn.lock (sometimes useful)
]);

const TREE_JUNK_PREFIXES = [
  "node_modules/", ".git/", "dist/", ".next/", ".vercel/",
  ".cache/", "coverage/", "__pycache__/", ".turbo/",
  "build/", "out/", ".nuxt/", ".output/",
  ".svelte-kit/", "vendor/", "target/",
];

// --- Secret detection ---

const SECRET_PATTERNS = [
  { name: "AWS Access Key", pattern: /AKIA[A-Z0-9]{16}/ },
  { name: "GitHub PAT (classic)", pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "GitHub PAT (fine-grained)", pattern: /github_pat_[a-zA-Z0-9_]{22,}/ },
  { name: "OpenAI/Anthropic Key", pattern: /sk-[a-zA-Z0-9]{20,}/ },
  { name: "Private Key", pattern: /-----BEGIN\s+.*PRIVATE KEY-----/ },
  { name: "Generic Secret", pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}/i },
];

export function isBlockedFile(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() || "";
  if (BLOCKED_NAMES.some((b) => name === b || name.startsWith(b))) return true;
  if (BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext) || lower.includes(ext + "."))) return true;
  return false;
}

export function isAllowedExtension(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() || "";
  // Allow extensionless files like Dockerfile, Makefile
  if (!name.includes(".")) return true;
  const ext = "." + name.split(".").pop();
  return ALLOWED_EXTENSIONS.has(ext);
}

export function scanForSecrets(content: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) found.push(name);
  }
  return found;
}

// --- Core fetch wrapper ---

function readRateLimit(res: Response) {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("x-ratelimit-limit");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining && limit && reset) {
    rateLimitInfo = {
      remaining: parseInt(remaining, 10),
      limit: parseInt(limit, 10),
      resetAt: parseInt(reset, 10),
    };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ghFetchRaw(pat: string, url: string): Promise<Response> {
  const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;

  // Deduplicate in-flight requests
  const existing = inflightRequests.get(fullUrl);
  if (existing) return existing.then((r) => r.clone());

  const doFetch = async (): Promise<Response> => {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const res = await fetch(fullUrl, {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      readRateLimit(res);

      if (res.ok) return res;

      // Rate limited
      if (res.status === 429 || (res.status === 403 && rateLimitInfo && rateLimitInfo.remaining === 0)) {
        if (attempt < 3) {
          const waitMs = Math.min(5000 * Math.pow(2, attempt), 30000) + Math.random() * 2000;
          await sleep(waitMs);
          continue;
        }
        const resetAt = rateLimitInfo?.resetAt;
        throw makeError(res.status, "Rate limited — try again later", true, resetAt);
      }

      // Server errors — retryable
      if (res.status >= 500 && attempt < 3) {
        await sleep(3000 * (attempt + 1));
        continue;
      }

      // Auth errors
      if (res.status === 401) {
        throw makeError(401, "GitHub token expired or invalid", false);
      }

      // Forbidden (SSO required, etc.)
      if (res.status === 403) {
        const body = await res.text().catch(() => "");
        if (body.includes("SSO")) {
          throw makeError(403, "This organization requires SSO authorization for your token", false);
        }
        throw makeError(403, "Access denied — check token permissions", false);
      }

      // Not found
      if (res.status === 404) {
        throw makeError(404, "Not found — check repo name or permissions", false);
      }

      // Empty repo
      if (res.status === 409) {
        throw makeError(409, "Repository is empty", false);
      }

      const text = await res.text().catch(() => "");
      throw makeError(res.status, text.slice(0, 200) || `GitHub API error: ${res.status}`, res.status >= 500);
    }
    throw makeError(0, "Max retries exceeded", false);
  };

  const promise = doFetch();
  inflightRequests.set(fullUrl, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    inflightRequests.delete(fullUrl);
  }
}

function makeError(status: number, message: string, retryable: boolean, resetAt?: number): GitHubApiError {
  return { status, message, retryable, resetAt };
}

// Typed fetch with JSON parsing
async function ghFetch<T>(pat: string, url: string): Promise<T> {
  const res = await ghFetchRaw(pat, url);
  return res.json() as Promise<T>;
}

// --- Public API ---

export function validatePat(pat: string): Promise<PatValidationResult> {
  return ghLimit(async () => {
    try {
      const res = await fetch(`${API_BASE}/user`, {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      readRateLimit(res);

      if (!res.ok) {
        if (res.status === 401) {
          return { valid: false, errorType: "bad_token" as const, message: "Invalid token — check for typos" };
        }
        if (res.status === 403) {
          const body = await res.text().catch(() => "");
          if (body.includes("SSO")) {
            return { valid: false, errorType: "sso_required" as const, message: "Organization requires SSO authorization" };
          }
          return { valid: false, errorType: "insufficient_scope" as const, message: "Token lacks required permissions" };
        }
        if (res.status === 429) {
          return { valid: false, errorType: "rate_limited" as const, message: "Rate limited — try again later" };
        }
        return { valid: false, message: `Unexpected error: ${res.status}` };
      }

      const data = await res.json();
      const scopeHeader = res.headers.get("x-oauth-scopes");
      const scopes = scopeHeader ? scopeHeader.split(",").map((s) => s.trim()) : [];

      return {
        valid: true,
        username: data.login,
        scopes,
      };
    } catch (err) {
      if ((err as GitHubApiError).status) throw err;
      return { valid: false, message: "Network error — check your connection" };
    }
  });
}

export function fetchRepos(pat: string): Promise<GitHubRepo[]> {
  return ghLimit(async () => {
    const allRepos: GitHubRepo[] = [];
    let url: string | null = "/user/repos?per_page=100&sort=updated&affiliation=owner,organization_member";

    while (url && allRepos.length < 300) {
      const res = await ghFetchRaw(pat, url);
      const data: Array<{ full_name: string; default_branch: string; private: boolean }> = await res.json();

      for (const r of data) {
        allRepos.push({
          full_name: r.full_name,
          default_branch: r.default_branch,
          private: r.private,
        });
      }

      // Parse Link header for pagination
      const linkHeader = res.headers.get("link") || "";
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    return allRepos;
  });
}

export function fetchBranches(pat: string, repo: string): Promise<{ name: string }[]> {
  return ghLimit(async () => {
    const data = await ghFetch<Array<{ name: string }>>(pat, `/repos/${repo}/branches?per_page=100`);
    return data.map((b) => ({ name: b.name }));
  });
}

export function fetchTree(pat: string, repo: string, branch: string): Promise<FetchTreeResult> {
  return ghLimit(async () => {
    const data = await ghFetch<{
      tree: Array<{ path: string; type: string; size?: number }>;
      truncated: boolean;
    }>(pat, `/repos/${repo}/git/trees/${branch}?recursive=1`);

    const files: RepoFile[] = [];
    for (const item of data.tree) {
      // Skip junk directories
      if (TREE_JUNK_PREFIXES.some((prefix) => item.path.startsWith(prefix))) continue;
      // Skip hidden directories (except root-level dotfiles like .gitignore)
      if (item.path.includes("/.") && item.type === "tree") continue;

      files.push({
        path: item.path,
        size: item.size ?? 0,
        type: item.type === "tree" ? "dir" : "file",
      });
    }

    return { files, truncated: data.truncated };
  });
}

export function fetchDirectory(pat: string, repo: string, path: string, branch: string): Promise<RepoFile[]> {
  return ghLimit(async () => {
    const data = await ghFetch<Array<{ name: string; path: string; type: string; size: number }>>(
      pat,
      `/repos/${repo}/contents/${path}?ref=${branch}`
    );

    return data.map((item) => ({
      path: item.path,
      size: item.size,
      type: item.type === "dir" ? "dir" as const : "file" as const,
    }));
  });
}

function decodeBase64Content(base64: string): string {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    // Fallback to Latin-1 for non-UTF-8 files
    return new TextDecoder("latin1").decode(bytes);
  }
}

export function fetchFileContent(
  pat: string,
  repo: string,
  path: string,
  branch: string
): Promise<FileFetchResult> {
  return ghLimit(async () => {
    // Check blocklist
    if (isBlockedFile(path)) {
      return { ok: false as const, reason: "blocked" as const };
    }

    try {
      const data = await ghFetch<{
        content?: string;
        encoding?: string;
        size: number;
        download_url?: string;
      }>(pat, `/repos/${repo}/contents/${path}?ref=${branch}`);

      // Size guard
      if (data.size > 500_000) {
        return { ok: false as const, reason: "too_large" as const };
      }

      // Standard base64 content
      if (data.content && data.encoding === "base64") {
        try {
          const content = decodeBase64Content(data.content.replace(/\n/g, ""));
          return { ok: true as const, content, size: data.size };
        } catch {
          return { ok: false as const, reason: "decode_failed" as const };
        }
      }

      // Large file fallback via download_url
      if (data.download_url) {
        try {
          const dlRes = await fetch(data.download_url);
          if (!dlRes.ok) return { ok: false as const, reason: "not_found" as const };
          const content = await dlRes.text();
          if (content.length > 500_000) return { ok: false as const, reason: "too_large" as const };
          return { ok: true as const, content, size: content.length };
        } catch {
          return { ok: false as const, reason: "decode_failed" as const };
        }
      }

      // Binary or unsupported
      return { ok: false as const, reason: "binary" as const };
    } catch (err) {
      const ghErr = err as GitHubApiError;
      if (ghErr.status === 404) return { ok: false as const, reason: "not_found" as const };
      throw err;
    }
  });
}
