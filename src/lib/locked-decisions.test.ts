import { describe, it, expect } from "bun:test";
import { extractLockedDecisions, lintLockedDecisions } from "./locked-decisions";

describe("extractLockedDecisions — heading form", () => {
  it("returns [] when no convention is present", () => {
    expect(extractLockedDecisions("# A plan\n\nSome prose.")).toEqual([]);
  });

  it("extracts top-level numbered items, one per entry", () => {
    const md = `# Plan

## Locked Decisions

1. One pipeline, dual-lens judge.
2. Legacy never breaks.
3. Council size stays 10.

## Design

stuff`;
    expect(extractLockedDecisions(md)).toEqual([
      "One pipeline, dual-lens judge.",
      "Legacy never breaks.",
      "Council size stays 10.",
    ]);
  });

  it("ends the section at the next ## heading (not bleeding into Design)", () => {
    const md = `## Locked Decisions

- A
- B

## Next

- C`;
    expect(extractLockedDecisions(md)).toEqual(["A", "B"]);
  });

  it("ends the section at EOF when no following heading", () => {
    const md = `## Locked Decisions

- only one`;
    expect(extractLockedDecisions(md)).toEqual(["only one"]);
  });

  it("folds nested bullets into their parent item", () => {
    const md = `## Locked Decisions

1. Default flip is gated and split.
   - flips ONLY after gates pass
   - in TWO separate commits
2. Machine-side only.`;
    expect(extractLockedDecisions(md)).toEqual([
      "Default flip is gated and split. flips ONLY after gates pass in TWO separate commits",
      "Machine-side only.",
    ]);
  });

  it("excludes a leading blockquote / intro before the first item", () => {
    const md = `## Locked Decisions

> Dogfooding the convention this plan introduces. Treat as fixed.

1. First real decision.`;
    expect(extractLockedDecisions(md)).toEqual(["First real decision."]);
  });

  it("tolerates a parenthetical note in the heading", () => {
    const md = `## Locked Decisions (constraints — do not fix)

- keep it`;
    expect(extractLockedDecisions(md)).toEqual(["keep it"]);
  });

  it("is case-insensitive on the heading text", () => {
    expect(extractLockedDecisions("## locked decisions\n\n- x")).toEqual(["x"]);
  });

  it("de-duplicates exact repeats, preserving order", () => {
    const md = `## Locked Decisions

- A
- B
- A`;
    expect(extractLockedDecisions(md)).toEqual(["A", "B"]);
  });
});

describe("extractLockedDecisions — frontmatter precedence", () => {
  it("frontmatter block-list WINS over the heading", () => {
    const md = `---
title: x
locked-decisions:
  - From frontmatter one
  - From frontmatter two
---

## Locked Decisions

- From heading (should be ignored)`;
    expect(extractLockedDecisions(md)).toEqual(["From frontmatter one", "From frontmatter two"]);
  });

  it("an explicit empty frontmatter list wins (honored as 'none'), not falling through to the heading", () => {
    const md = `---
locked-decisions:
title: x
---

## Locked Decisions

- heading item`;
    // locked-decisions: present but empty block → [] wins over the heading.
    expect(extractLockedDecisions(md)).toEqual([]);
  });

  it("supports an inline scalar", () => {
    expect(extractLockedDecisions("---\nlocked-decisions: just one\n---\n")).toEqual(["just one"]);
  });

  it("supports an inline flow list", () => {
    expect(extractLockedDecisions("---\nlocked-decisions: [a, b, c]\n---\n")).toEqual(["a", "b", "c"]);
  });

  it("falls through to the heading when frontmatter has no locked-decisions key", () => {
    const md = `---
title: x
---

## Locked Decisions

- heading wins here`;
    expect(extractLockedDecisions(md)).toEqual(["heading wins here"]);
  });
});

describe("lintLockedDecisions — pre-flight near-miss detection (T8)", () => {
  it("flags a misspelled / wrong-level heading", () => {
    const lint = lintLockedDecisions("### Locked Decisons\n\n- x");
    expect(lint.nearMissHeading).toContain("Locked Decisons");
    expect(lint.warnings.length).toBeGreaterThan(0);
  });

  it("is clean for a correct heading with items", () => {
    const lint = lintLockedDecisions("## Locked Decisions\n\n- real item");
    expect(lint.nearMissHeading).toBeNull();
    expect(lint.malformedFrontmatter).toBe(false);
    expect(lint.warnings).toEqual([]);
  });

  it("flags a singular frontmatter key near-miss", () => {
    const lint = lintLockedDecisions("---\nlocked-decision: oops\n---\n");
    expect(lint.malformedFrontmatter).toBe(true);
  });

  it("flags a present-but-empty locked-decisions key with no items anywhere", () => {
    const lint = lintLockedDecisions("---\nlocked-decisions:\ntitle: x\n---\n\nbody");
    expect(lint.malformedFrontmatter).toBe(true);
  });

  it("is clean when there is no convention at all (no false positive)", () => {
    const lint = lintLockedDecisions("# Plan\n\njust prose");
    expect(lint.warnings).toEqual([]);
    expect(lint.nearMissHeading).toBeNull();
  });
});
