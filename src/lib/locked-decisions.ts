// ═══════════════════════════════════════════════════════════════════════════
// Model Prism — deterministic Locked Decisions extraction (D1 / T1, council G3)
//
// The founder convention: an author marks constraints the council must NOT "fix"
// with a `## Locked Decisions` heading (or a `locked-decisions:` frontmatter list).
// These are extracted DETERMINISTICALLY here, BEFORE the judge call, and injected
// as pre-validated context. The judge only ACKNOWLEDGES them — it never reproduces
// them (an LLM "echo" is not deterministic: it can paraphrase, drop numbering, or
// truncate a long constraint block — the original L3 risk). Zero extra tokens.
//
// Pure + fully unit-tested (locked-decisions.test.ts). No I/O, no git, no network.
// ═══════════════════════════════════════════════════════════════════════════

// Strip a leading YAML frontmatter block, returning {fm, body}. Mirrors the
// regex-frontmatter idiom already used in rosters.ts (no YAML dep in this repo).
function splitFrontmatter(content: string): { fm: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { fm: null, body: content };
  return { fm: m[1], body: content.slice(m[0].length) };
}

// Parse a `locked-decisions:` block-list out of frontmatter. Supports the common
// YAML block-list form:
//   locked-decisions:
//     - item one
//     - item two
// and a single inline scalar (`locked-decisions: one thing`). Returns null when the
// key is absent (so the caller can fall through to the heading), [] when present but
// empty (an explicit, honored "no locked decisions").
function lockedDecisionsFromFrontmatter(fm: string | null): string[] | null {
  if (!fm) return null;
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^locked-decisions\s*:/.test(l));
  if (idx === -1) return null;

  const keyLine = lines[idx];
  const inline = keyLine.replace(/^locked-decisions\s*:/, "").trim();
  // Inline non-list scalar: `locked-decisions: only one`.
  if (inline && !inline.startsWith("[")) return [inline];
  // Inline flow list: `locked-decisions: [a, b]`.
  if (inline.startsWith("[")) {
    const inner = inline.replace(/^\[/, "").replace(/\]$/, "");
    const items = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return items;
  }

  // Block list: subsequent `  - item` lines until indentation drops to a new key.
  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s+/.test(line)) {
      items.push(line.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
    } else if (/^\S/.test(line)) {
      break; // a new top-level frontmatter key
    } else if (line.trim() === "") {
      continue;
    } else {
      break;
    }
  }
  return items;
}

// Extract the `## Locked Decisions` section body (up to the next `## ` heading or
// EOF) and fold it into one entry per top-level numbered/bulleted item. Nested
// bullets are folded into their parent item; the intro blockquote/paragraph before
// the first list item is excluded.
function lockedDecisionsFromHeading(body: string): string[] {
  // Match a level-2 heading whose text is "Locked Decisions" (case-insensitive),
  // tolerant of trailing parenthetical notes like "## Locked Decisions (constraints)".
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+locked\s+decisions\b/i.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return [];

  // Section ends at the next level-2 (or higher) heading.
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  }
  const section = lines.slice(start, end);

  const items: string[] = [];
  let current: string | null = null;
  // A top-level item starts at column 0 with `1.` / `-` / `*` / `+`. A line indented
  // under it (nested bullet or wrapped text) folds into the current item.
  const topItemRe = /^(\d+[.)]\s+|[-*+]\s+)(.*)$/;
  const nestedRe = /^\s+(\d+[.)]\s+|[-*+]\s+)?(.*)$/;

  for (const raw of section) {
    const line = raw.replace(/\s+$/g, "");
    if (line.trim() === "") continue;
    // Blockquote / intro paragraph before the first item is excluded.
    if (current === null && /^>/.test(line)) continue;

    const top = topItemRe.exec(line);
    if (top && !/^\s/.test(raw)) {
      if (current !== null) items.push(current.trim());
      current = top[2].trim();
      continue;
    }
    if (current !== null) {
      // Fold nested bullet / wrapped continuation into the current item.
      const nested = nestedRe.exec(line);
      const text = nested ? nested[2].trim() : line.trim();
      if (text) current += ` ${text}`;
      continue;
    }
    // Non-list intro paragraph before any item: excluded.
  }
  if (current !== null) items.push(current.trim());
  return items;
}

// Collapse repeated whitespace inside an item (nested folds introduce spaces).
function normalizeItem(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Deterministically extract a plan's Locked Decisions.
 *
 * Precedence (resolved, not "or"): a `locked-decisions:` frontmatter key WINS over
 * the `## Locked Decisions` heading when present (even if it is an explicit empty
 * list). Exact-duplicate items are de-duplicated, order preserved.
 *
 * Returns [] when the plan carries no convention at all.
 */
export function extractLockedDecisions(draft: string): string[] {
  const { fm, body } = splitFrontmatter(draft);
  const fromFm = lockedDecisionsFromFrontmatter(fm);
  const raw = fromFm !== null ? fromFm : lockedDecisionsFromHeading(body);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw.map(normalizeItem).filter(Boolean)) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export interface LockedDecisionsLint {
  // A heading that LOOKS like the convention but won't be parsed (typo / wrong level).
  nearMissHeading: string | null;
  // A frontmatter key that looks malformed (present but yielded nothing).
  malformedFrontmatter: boolean;
  warnings: string[];
}

/**
 * Pre-flight zero-token linter (T8). Catches a near-miss heading (`### Locked
 * Decisons`, wrong level, misspelled) or a malformed `locked-decisions:` frontmatter
 * key BEFORE any council spend — so the author fixes it instead of silently shipping
 * an empty mandatory section. Pure; never throws.
 */
export function lintLockedDecisions(draft: string): LockedDecisionsLint {
  const { fm, body } = splitFrontmatter(draft);
  const warnings: string[] = [];

  const extracted = extractLockedDecisions(draft);
  let nearMissHeading: string | null = null;

  // Heading near-miss: a line that contains "locked" + "decision(s)" in a heading but
  // did NOT match the canonical `## Locked Decisions` form the extractor accepts.
  if (extracted.length === 0) {
    for (const line of body.split(/\r?\n/)) {
      if (/^#{1,6}\s/.test(line) && /locked/i.test(line) && /decis/i.test(line)) {
        if (!/^##\s+locked\s+decisions\b/i.test(line)) {
          nearMissHeading = line.trim();
          warnings.push(`Near-miss Locked Decisions heading will NOT be parsed: "${line.trim()}". Use a level-2 "## Locked Decisions" heading.`);
        }
        break;
      }
    }
  }

  // Frontmatter near-miss: a `locked-decision` (singular) or similar key, or a
  // `locked-decisions:` key that parsed to nothing.
  let malformedFrontmatter = false;
  if (fm) {
    const hasCanonical = /^locked-decisions\s*:/m.test(fm);
    const hasNearMiss = /^locked[-_ ]?decision[s]?\s*:/im.test(fm) && !hasCanonical;
    if (hasNearMiss) {
      malformedFrontmatter = true;
      warnings.push(`Frontmatter key near-miss: use "locked-decisions:" (plural, hyphenated).`);
    } else if (hasCanonical && extracted.length === 0) {
      malformedFrontmatter = true;
      warnings.push(`"locked-decisions:" frontmatter present but yielded no items — check the list indentation.`);
    }
  }

  return { nearMissHeading, malformedFrontmatter, warnings };
}
