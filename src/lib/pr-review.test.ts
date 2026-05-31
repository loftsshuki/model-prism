import { describe, expect, test } from "bun:test";
import { buildGithubReviewMarkdown, parseDiffFiles, summarizeDiffFiles } from "./pr-review";

describe("PR review helpers", () => {
  const diff = `diff --git a/src/app/api/foo/route.ts b/src/app/api/foo/route.ts
index 1..2 100644
--- a/src/app/api/foo/route.ts
+++ b/src/app/api/foo/route.ts
@@ -1,2 +1,3 @@
-old
+new
+more
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-docs
+better docs`;

  test("parses changed files and line counts", () => {
    const files = parseDiffFiles(diff);
    expect(files).toEqual([
      { path: "src/app/api/foo/route.ts", additions: 2, deletions: 1 },
      { path: "README.md", additions: 1, deletions: 1 },
    ]);
  });

  test("summarizes risky files and emits GitHub-ready markdown", () => {
    const files = parseDiffFiles(diff);
    const summary = summarizeDiffFiles(files);
    expect(summary.riskyFiles[0].path).toContain("api");

    const markdown = buildGithubReviewMarkdown({ url: "https://github.com/a/b/pull/1", files });
    expect(markdown).toContain("Files changed: 2");
    expect(markdown).toContain("Risk-sensitive files");
  });
});
