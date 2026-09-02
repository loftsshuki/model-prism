import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  extractReferences,
  checkGroundTruth,
  renderFactsBlock,
  markUnverifiedFindings,
  type GroundTruthReport,
} from "./ground-truth";

// ── Fixture repo ────────────────────────────────────────────────────────────

const FIXTURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", version: "0.0.0" }),
  "src/lib/auth.ts": [
    "export function requireAdminToken(req: Request): boolean {",
    "  return req.headers.get('x-admin') === process.env.ADMIN_TOKEN;",
    "}",
    "export class SessionStore {",
    "  revoke(id: string) { return id; }",
    "}",
    "",
  ].join("\n"),
  "src/lib/db.ts": "export const dbClient = { query: (sql: string) => sql };\n",
  "src/app/api/review/route.ts": "export async function POST() { return new Response('ok'); }\n",
  "supabase/migrations/0001_init.sql": [
    "CREATE TABLE IF NOT EXISTS public.\"user_sessions\" (id uuid primary key);",
    "create table review_runs (id serial);",
    "",
  ].join("\n"),
  "docs/plans/self-referential.md": "This doc mentions `phantomHelper` and `docs_only_table` table but nothing defines them.\n",
  ".env.example": "ADMIN_TOKEN=change-me\nOPENROUTER_API_KEY=\n",
};

function writeFixture(root: string): void {
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

let gitRoot: string;
let plainRoot: string;

beforeAll(() => {
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ground-truth-git-"));
  writeFixture(gitRoot);
  git(gitRoot, "init", "-q");
  git(gitRoot, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  git(gitRoot, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "fixture");

  plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ground-truth-fs-"));
  writeFixture(plainRoot);
});

afterAll(() => {
  fs.rmSync(gitRoot, { recursive: true, force: true });
  fs.rmSync(plainRoot, { recursive: true, force: true });
});

// ── extractReferences ───────────────────────────────────────────────────────

describe("extractReferences", () => {
  it("extracts backticked, quoted, linked and bare repo paths", () => {
    const plan = [
      "Edit `src/lib/auth.ts` and \"src/lib/db.ts\", then add supabase/migrations/0002_x.sql.",
      "See [the route](src/app/api/review/route.ts) and app/(auth)/[id]/page.tsx; also update package.json.",
      "Directory refs like `src/lib/` count too.",
    ].join("\n");
    const { paths } = extractReferences(plan);
    expect(paths).toContain("src/lib/auth.ts");
    expect(paths).toContain("src/lib/db.ts");
    expect(paths).toContain("supabase/migrations/0002_x.sql");
    expect(paths).toContain("src/app/api/review/route.ts");
    expect(paths).toContain("app/(auth)/[id]/page.tsx");
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/lib/");
  });

  it("resists URL, prose and framework-name false positives", () => {
    const plan = [
      "Read https://example.com/docs/guide.md and http://x.io/a.ts first.",
      "This is an and/or choice; read/write splits; N/A. Uses Next.js and Node.js, e.g. version 1.2.3.",
      "Avoid node_modules/foo/index.js and ../outside/secret.ts and /etc/passwd.txt.",
    ].join("\n");
    const { paths, symbols } = extractReferences(plan);
    expect(paths).toEqual([]);
    expect(symbols).toEqual([]);
  });

  it("dedupes and strips trailing punctuation", () => {
    const { paths } = extractReferences("Touch `src/lib/auth.ts`, `src/lib/auth.ts`. Then (src/lib/db.ts).");
    expect(paths.filter((p) => p === "src/lib/auth.ts")).toHaveLength(1);
    expect(paths).toContain("src/lib/db.ts");
  });

  it("extracts code-like backticked symbols and drops English words", () => {
    const plan =
      "Reuse `requireAdminToken()`, `SessionStore.revoke`, `db_client`, `fooBar` and `Widget`; " +
      "the `handler`, `Router`, `true`, `null`, `TODO` and `id` tokens are noise.";
    const { symbols } = extractReferences(plan);
    expect(symbols).toEqual(expect.arrayContaining(["requireAdminToken", "SessionStore.revoke", "db_client", "fooBar"]));
    for (const noise of ["handler", "Router", "Widget", "true", "null", "TODO", "id"]) {
      expect(symbols).not.toContain(noise);
    }
  });

  it("extracts tables from DDL, SQL clauses, prose and supabase.from()", () => {
    const plan = [
      "CREATE TABLE IF NOT EXISTS public.\"audit_log\" (...); ALTER TABLE user_sessions ADD COLUMN x;",
      "SELECT * FROM review_runs JOIN model_costs ON ...; but nothing from the prose.",
      "The `feature_flags` table and table `api_keys` plus the rate_limits table; supabase.from('profiles').",
    ].join("\n");
    const { tables, symbols } = extractReferences(plan);
    expect(tables).toEqual(
      expect.arrayContaining(["audit_log", "user_sessions", "review_runs", "model_costs", "feature_flags", "api_keys", "rate_limits", "profiles"])
    );
    expect(tables).not.toContain("the");
    // Backticked table names are not double-counted as symbols.
    expect(symbols).not.toContain("feature_flags");
  });

  it("extracts env vars from backticks and process.env only", () => {
    const plan = "Set `OPENROUTER_API_KEY` and read process.env.ADMIN_TOKEN; `HTTPS` has no underscore and `AB_C` is too short; ADMIN_TOKEN bare in prose is ignored.";
    const { envVars } = extractReferences(plan);
    expect(envVars).toEqual(expect.arrayContaining(["OPENROUTER_API_KEY", "ADMIN_TOKEN"]));
    expect(envVars).not.toContain("HTTPS");
    expect(envVars).not.toContain("AB_C");
    expect(envVars).toHaveLength(2);
  });
});

// ── checkGroundTruth ────────────────────────────────────────────────────────

const PLAN = [
  "Extend `src/lib/auth.ts` (calls `requireAdminToken()` and `SessionStore.revoke`) and create `src/lib/nope.ts`.",
  "Also touch `lib/auth.ts` and `src/lib/db.ts`. Reuse `phantomHelper` which does not exist.",
  "Tables: ALTER TABLE user_sessions; CREATE TABLE review_events (id serial); the `ghost_table` table; the `review_runs` table.",
  "Env: `ADMIN_TOKEN`, `OPENROUTER_API_KEY`, `NOT_SET_ANYWHERE`.",
].join("\n");

function byName(report: GroundTruthReport, kind: string, name: string) {
  const ref = report.refs.find((r) => r.kind === kind && r.name === name);
  if (!ref) throw new Error(`ref ${kind}:${name} missing from report`);
  return ref;
}

for (const backend of ["git", "fs"] as const) {
  describe(`checkGroundTruth (${backend} backend)`, () => {
    let report: GroundTruthReport;
    beforeAll(() => {
      report = checkGroundTruth(PLAN, backend === "git" ? gitRoot : plainRoot, { backend, timeoutMs: 20_000 });
    });

    it("finds existing paths and marks new ones missing", () => {
      expect(byName(report, "path", "src/lib/auth.ts").status).toBe("found");
      expect(byName(report, "path", "src/lib/db.ts").status).toBe("found");
      expect(byName(report, "path", "src/lib/nope.ts").status).toBe("missing");
    });

    it("marks a wrong-directory path ambiguous with the real candidate", () => {
      const ref = byName(report, "path", "lib/auth.ts");
      expect(ref.status).toBe("ambiguous");
      expect(ref.matches).toEqual(["src/lib/auth.ts"]);
    });

    it("finds symbols with path:line matches and marks unknown ones missing", () => {
      const found = byName(report, "symbol", "requireAdminToken");
      expect(found.status).toBe("found");
      expect(found.matches).toEqual(["src/lib/auth.ts:1"]);
      expect(byName(report, "symbol", "phantomHelper").status).toBe("missing");
    });

    it("reports Class.method as ambiguous when only the member name exists", () => {
      const ref = byName(report, "symbol", "SessionStore.revoke");
      expect(ref.status).toBe("ambiguous");
      expect(ref.matches[0]).toMatch(/^src\/lib\/auth\.ts:\d+$/);
    });

    it("finds tables via CREATE TABLE (quoted, schema-prefixed, IF NOT EXISTS, any case)", () => {
      expect(byName(report, "table", "user_sessions").status).toBe("found");
      expect(byName(report, "table", "review_runs").status).toBe("found");
      expect(byName(report, "table", "ghost_table").status).toBe("missing");
    });

    it("treats a table the plan itself creates as found with a note", () => {
      const ref = byName(report, "table", "review_events");
      expect(ref.status).toBe("found");
      expect(ref.note).toBe("created by this plan");
    });

    it("finds env vars via code or .env.example and marks unknown ones missing", () => {
      const admin = byName(report, "env", "ADMIN_TOKEN");
      expect(admin.status).toBe("found");
      expect(admin.matches).toContain(".env.example:1");
      expect(admin.matches).toContain("src/lib/auth.ts:2");
      const key = byName(report, "env", "OPENROUTER_API_KEY");
      expect(key.status).toBe("found");
      expect(key.matches).toEqual([".env.example:2"]);
      expect(byName(report, "env", "NOT_SET_ANYWHERE").status).toBe("missing");
    });

    it("keeps the counters consistent", () => {
      expect(report.found + report.missing + report.ambiguous).toBe(report.refs.length);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
}

describe("checkGroundTruth budgets", () => {
  it("marks references beyond maxRefs as not checked", () => {
    const report = checkGroundTruth(PLAN, gitRoot, { maxRefs: 2 });
    expect(report.refs.length).toBeGreaterThan(2);
    const skipped = report.refs.slice(2);
    expect(skipped.every((r) => r.status === "ambiguous" && r.note === "not checked (budget)")).toBe(true);
  });

  it("stops grepping once timeoutMs has elapsed", () => {
    const report = checkGroundTruth(PLAN, gitRoot, { timeoutMs: 0 });
    const symbols = report.refs.filter((r) => r.kind === "symbol");
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every((r) => r.status === "ambiguous" && r.note === "not checked (budget)")).toBe(true);
  });

  it("does not let a plan inside the repo verify its own claims", () => {
    const planPath = "docs/plans/self-referential.md";
    const plan = fs.readFileSync(path.join(gitRoot, planPath), "utf8");
    const report = checkGroundTruth(plan, gitRoot, { planPath });
    expect(byName(report, "symbol", "phantomHelper").status).toBe("missing");
    expect(byName(report, "table", "docs_only_table").status).toBe("missing");
  });

  it("returns an empty report for a plan with no references", () => {
    const report = checkGroundTruth("Rewrite the intro paragraph to be friendlier.", gitRoot);
    expect(report.refs).toEqual([]);
    expect(renderFactsBlock(report)).toBe("");
  });
});

// ── renderFactsBlock ────────────────────────────────────────────────────────

describe("renderFactsBlock", () => {
  it("lists found, missing and ambiguous refs with matches and the instruction", () => {
    const report: GroundTruthReport = {
      refs: [
        { kind: "path", name: "src/lib/auth.ts", status: "found", matches: ["src/lib/auth.ts"] },
        { kind: "symbol", name: "phantomHelper", status: "missing", matches: [] },
        { kind: "table", name: "review_events", status: "found", matches: [], note: "created by this plan" },
        { kind: "path", name: "lib/auth.ts", status: "ambiguous", matches: ["src/lib/auth.ts"], note: "not at that path; same filename found elsewhere" },
      ],
      found: 2,
      missing: 1,
      ambiguous: 1,
      durationMs: 3,
    };
    const block = renderFactsBlock(report);
    expect(block.startsWith("<verified_facts>")).toBe(true);
    expect(block.endsWith("</verified_facts>")).toBe(true);
    expect(block).toContain("2 found, 1 missing, 1 ambiguous");
    expect(block).toContain("FOUND");
    expect(block).toContain("MISSING");
    expect(block).toContain("AMBIGUOUS");
    expect(block).toContain("- symbol `phantomHelper`");
    expect(block).toContain("- table `review_events` (created by this plan)");
    expect(block).toContain("- path `lib/auth.ts` → src/lib/auth.ts (not at that path");
    expect(block).toContain("treat MISSING as ground truth");
    expect(block).toContain("never invent paths");
  });
});

// ── markUnverifiedFindings ──────────────────────────────────────────────────

describe("markUnverifiedFindings", () => {
  const report: GroundTruthReport = {
    refs: [
      { kind: "path", name: "src/lib/nope.ts", status: "missing", matches: [] },
      { kind: "symbol", name: "phantomHelper", status: "missing", matches: [] },
      { kind: "path", name: "src/lib/auth.ts", status: "found", matches: ["src/lib/auth.ts"] },
      { kind: "symbol", name: "SessionStore.revoke", status: "ambiguous", matches: ["src/lib/auth.ts:5"] },
    ],
    found: 1,
    missing: 2,
    ambiguous: 1,
    durationMs: 1,
  };

  it("flags findings whose location or claim names a missing ref, and leaves others untouched", () => {
    const findings = [
      { claim: "Validation is skipped.", location: "src/lib/nope.ts" },
      { claim: "phantomHelper swallows errors silently.", evidence: "n/a" },
      { claim: "phantomHelperX is unrelated (no word boundary).", location: "src/lib/auth.ts" },
      { claim: "SessionStore.revoke is never awaited.", location: "src/lib/auth.ts" },
    ];
    const marked = markUnverifiedFindings(findings, report);
    expect(marked[0].unverified).toBe(true);
    expect(marked[1].unverified).toBe(true);
    expect(marked[2]).toBe(findings[2]);
    expect("unverified" in marked[2]).toBe(false);
    expect("unverified" in marked[3]).toBe(false);
  });

  it("is a no-op when nothing is missing", () => {
    const findings = [{ claim: "x", location: "y" }];
    const clean: GroundTruthReport = { refs: [], found: 0, missing: 0, ambiguous: 0, durationMs: 0 };
    expect(markUnverifiedFindings(findings, clean)).toBe(findings);
  });
});
