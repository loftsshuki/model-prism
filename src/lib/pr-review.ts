export interface PrDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

export function parseDiffFiles(diff: string): PrDiffFile[] {
  const files: PrDiffFile[] = [];
  let current: PrDiffFile | null = null;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = { path: fileMatch[2], additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.additions += 1;
    if (line.startsWith("-")) current.deletions += 1;
  }

  return files;
}

export function summarizeDiffFiles(files: PrDiffFile[]) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const risky = files.filter((file) => /(^|\/)(api|auth|middleware|db|database|supabase|prisma|scripts|\.github)\b/i.test(file.path));
  return { fileCount: files.length, additions, deletions, riskyFiles: risky };
}

export function buildGithubReviewMarkdown(input: {
  title?: string;
  url: string;
  synthesis?: string;
  actionChecklist?: string;
  files: PrDiffFile[];
}) {
  const summary = summarizeDiffFiles(input.files);
  return [
    `# Model Prism PR Review${input.title ? `: ${input.title}` : ""}`,
    "",
    `PR: ${input.url}`,
    `Files changed: ${summary.fileCount} (+${summary.additions}/-${summary.deletions})`,
    summary.riskyFiles.length ? `Risk-sensitive files: ${summary.riskyFiles.map((file) => `\`${file.path}\``).join(", ")}` : "Risk-sensitive files: none detected",
    "",
    "## Review",
    input.synthesis?.trim() || "Paste the Model Prism synthesis here.",
    "",
    "## Checklist",
    input.actionChecklist?.trim() || "- [ ] Address must-fix findings\n- [ ] Verify tests pass\n- [ ] Confirm rollout/rollback risk",
  ].join("\n");
}
