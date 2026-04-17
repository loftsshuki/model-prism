Your job is to produce a MASTER DOCUMENT synthesizing an audit-program meta-review across N independent reviewer models.

Each model was asked to evaluate the completeness and appropriateness of the audit program for a **pre-launch consumer luxury real-estate platform** built by a non-technical solo founder. Each model followed this output structure: MISSING REVIEWS / OVER-SCOPED / CONSOLIDATIONS / MISSING LENSES / TIER CHALLENGES / CROSS-REVIEW GAPS / META.

**Rules for the masterDocument:**

- Write as if YOU are a single senior audit-program reviewer delivering the final recommendation to the orchestrator.
- Preserve the 7-section structure the individual reviewers used: **MISSING REVIEWS**, **OVER-SCOPED / DEFERRABLE REVIEWS**, **CONSOLIDATIONS**, **MISSING LENSES**, **TIER PLACEMENT CHALLENGES**, **CROSS-REVIEW COORDINATION GAPS**, **META**.

**In MISSING REVIEWS (most important section):**

- Dedupe: if 3 reviewers proposed "email deliverability audit" under slightly different names, that's one review, not three. Combine the strongest framing.
- **Weight by distinct architecture** — 3 models in the same family agreeing on a missing review is 1 vote, not 3. A divergent-family model (e.g. Grok or Qwen) proposing a review alone is still signal, not noise — surface it with appropriate confidence.
- **Apply the pre-launch-consumer-real-estate filter aggressively:** drop proposals that any reviewer made but that genuinely don't fit the business context (e.g. "SOC 2 compliance audit," "multi-region failover drill" for a single-market pre-launch product).
- **Severity tiering must match justification:** if a reviewer tagged something "existential" but the failure mode they named is at-worst "serious," downgrade the tier. Be honest.
- **Preserve the proposer's best framing** for each review — don't water down specific failure-mode language. Generic justifications ("industry best practice") are worthless; concrete failure modes ("without this, an EU visitor's GDPR deletion request breaches the 30-day deadline") are the whole point.

For each MISSING REVIEW in the final list:
- Short name in "[Letter]. [Phrase]" format matching the catalog
- Concrete pre-launch failure it prevents (one sentence)
- Tier placement (1/2/3/specialty)
- Rough scope in 1-3 bullets
- Consolidation notes: which existing reviews it overlaps with
- Support: which model architectures proposed it (single model = "uncontested unique insight"; multiple = consensus)

**In OVER-SCOPED / DEFERRABLE REVIEWS:**
- Consolidate proposals for the same existing review
- Be explicit about what specifically doesn't fit the stage (e.g. "i18n review is already Deferred in the catalog" vs. "performance deep-dive is Tier 3 but should be Tier 2")

**In CONSOLIDATIONS:**
- Only flag merges where there is concrete semantic overlap, not surface-level naming similarity. Two reviews that both touch "SEO" may still be correctly split if one is about structured data and the other about site architecture.

**In MISSING LENSES:**
- Attach each lens proposal to a specific existing review by name
- Describe the concrete failure the new lens would catch (not "it would improve coverage")

**In TIER PLACEMENT CHALLENGES:**
- Only include items where at least one reviewer challenged placement AND the challenge has concrete justification
- Note both the current tier and the recommended tier

**In CROSS-REVIEW COORDINATION GAPS:**
- Only include handoffs that are ACTUALLY missing in the program doc, not just "would be nice if documented"

**End the masterDocument with a PRIORITIZED ACTION LIST:**

3-8 items the orchestrator should execute on, each formatted as:
- **[Action]**: Scaffold / Demote / Consolidate / Add Lens / Flag Tier
- **[Target]**: specific review letter + phrase
- **[Effort]**: rough estimate (30min / 2h / 1day) for scaffolding a tracker doc, zero for taxonomy changes
- **[Why]**: one sentence

Do NOT invent reviews in the action list that weren't proposed by any of the N reviewer models. The synthesis is deduplication and prioritization, not generation.

**Rules for other synthesis fields:**

- **consensus**: review proposals or challenges that ≥3 distinct architectures all raised. Each entry: the point + strength (strong/moderate/weak) + supporting model IDs.
- **uniqueInsights**: proposals from only 1-2 models — often highest signal for this use case because they escaped the consensus blind spot. Mark significance (critical / important / minor) + source model.
- **disagreements**: cases where reviewers split on whether a review is needed, or what tier it belongs in. List positions side-by-side.
- **blindSpots**: failure modes or risk categories that NONE of the N reviewers engaged with. This is where the meta-review itself is weakest and a human should think harder.
- **themeMatrix**: 4-8 themes (e.g. "Legal / compliance," "Security," "Operational resilience," "Content integrity," etc.). Score every model 0-3 on how deeply they engaged with each theme.

**Do not output code-review language** (CONFIRMED / MISSED / DISAGREES / WEAKER-SEVERITY). This is a program-level meta-review, not a code review. The framing above is authoritative.
