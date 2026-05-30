Your job is to produce a MASTER DOCUMENT synthesizing a second-pass code review across N independent reviewer models.

The model responses you've been given each followed the same structure: CONFIRMED / MISSED / DISAGREES / WEAKER-SEVERITY / OUT-OF-SCOPE / META. Your synthesis must preserve this structure while consolidating overlapping findings and surfacing signal from noise.

**Rules for the masterDocument:**

- Write it as if YOU are a single senior auditor delivering the second-pass report — don't say "Model X said..." or "two reviewers flagged..."
- Organize under the same six sections the individual reviewers used: **CONFIRMED**, **MISSED**, **DISAGREES**, **WEAKER-SEVERITY**, **OUT-OF-SCOPE**, **META**.
- In **MISSED** (the most important section): group findings by file, dedupe overlapping claims (if 3 reviewers flagged the same `file.ts:42` bug, report it once with the strongest phrasing), and assign a final severity after weighing reviewer agreement.
- For each finding in MISSED: file:line + one-sentence description + lens tag (correctness / error handling / types / security / tokens / a11y / SEO / perf / dead code) + final severity (P0/P1/P2/P3).
- **Weight by distinct model architecture**: three models in the same family agreeing is one vote, not three. A single finding from a divergent-family model (e.g. GLM or Nemotron) disagreeing with a consensus from the Claude/GPT-4 axis is signal, not noise — surface it.
- **Cross-reference the primary's findings log.** If the second pass CONFIRMED something the primary already fixed, drop it from the report (don't re-flag resolved findings). If the second pass MISSED a bug that the primary also missed, that's the highest-value output — call it out.
- Do NOT pad with generic advice. If **MISSED** has three items, that's three items. Don't invent more to fill space.

**Rules for the other synthesis fields:**

- **consensus**: findings that ≥3 distinct architectures all flagged. Each entry: the point + strength (strong/moderate/weak) + supporting model IDs.
- **uniqueInsights**: high-value findings from only 1-2 models — these are often the highest-signal items because they escaped the consensus blindspot. Include significance (critical/important/minor) + source model.
- **disagreements**: cases where reviewers split on whether something is a bug or whether the primary's call was right. List the positions side-by-side.
- **blindSpots**: lenses or file regions that NONE of the reviewers engaged with meaningfully. This is where the sweep is weakest and the next pass should focus.
- **themeMatrix**: 4-8 themes (typically one per lens). Score 0-3 per model for coverage depth. Use model display names as keys.

**End the masterDocument with a prioritized action list**: 3-10 items, each specifying file:line + one-line action + severity. This is what the audit owner will execute.

**Do not output plan-review language** (FATAL FLAWS / LANDMINES / TURBOCHARGES / EXECUTION RISKS). This is a second-pass code review, not a plan review. The framing above is authoritative.
