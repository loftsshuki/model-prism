You are evaluating the **completeness and appropriateness of a pre-launch audit program** for a consumer-facing web platform. The input is the program's master tracker doc (a catalog of reviews, each with scope and status), plus its dependent tracker docs (auto-loaded as PLAN-REFERENCED FILES in the context block).

**Project context you must weigh every recommendation against:**

- **Product:** consumer-facing luxury real-estate platform (Next.js on Vercel, Supabase for DB + auth + edge functions)
- **Stage:** pre-launch. Not yet live, no real user traffic, no revenue
- **Team:** non-technical solo founder, working through Claude Code as primary engineering resource
- **Risk posture:** wants to be as thorough as possible before launch. Code has been written over multiple Claude generations (4.5 → 4.6 → 4.7). This is the window to catch correctness bugs, compliance exposure, and security gaps before users arrive
- **Business model:** listing marketplace + concierge services. Real estate is heavily regulated (Fair Housing Act, state advertising laws, TRID, CAN-SPAM for emails, GDPR for EU touchpoints). Pre-launch compliance posture is non-negotiable — an early cease-and-desist from a state AG or a Fair Housing complaint would be existential.

**What you are NOT evaluating:**

- Code quality of any specific review's findings (separate exercise)
- Implementation details inside any tracker
- Generic "SaaS best practices" — only what matters for THIS business at THIS stage

**What you ARE evaluating:**

1. **Missing reviews (highest value)** — pre-launch failure modes that no review in the catalog would catch. For each: name the review, state the concrete pre-launch failure it prevents (not "it's good practice"), estimate impact if skipped (existential / serious / minor), propose a tier placement (1 = launch-blocker, 2 = 90-day post-launch, 3 = ongoing cadence). If it's a specialty agent-run rather than a full review, say so.

2. **Over-scoped reviews** — items in the catalog that are premature, irrelevant for a pre-launch consumer-real-estate play, or better deferred. For each: what's in the catalog, why it doesn't earn its slot at this stage, where it should go instead (deferred / post-revenue / remove entirely).

3. **Review consolidations** — cases where two existing reviews overlap enough that merging them reduces duplication without losing coverage. Be specific about what overlaps and what gets preserved.

4. **Missing lenses within existing reviews** — things a review SHOULD check but its scope doesn't mention. Name the review, the missing lens, and the concrete thing it would catch.

5. **Tier placement challenges** — reviews currently in Tier 1 (launch-blocking) that shouldn't be, or reviews currently in Tier 2/3 that should be Tier 1 for a pre-launch consumer-real-estate play.

6. **Cross-review coordination gaps** — areas where Review X's findings need to feed into Review Y but the program has no documented handoff. Be specific about which reviews, which findings.

**Output structure** (omit any section that is empty with a one-line note):

**1. MISSING REVIEWS** — highest-value section. For each new review proposed:
- Short name (single letter + phrase, matching the catalog style — e.g. "Y. Email deliverability & sender reputation")
- Concrete pre-launch failure it prevents (one sentence, specific)
- Tier placement (1/2/3/specialty)
- Rough scope (what does this review check?)
- Which existing review(s) it overlaps with, if any (for future consolidation)

**2. OVER-SCOPED / DEFERRABLE REVIEWS**
- Name in catalog
- Why it doesn't earn its slot at this stage
- Recommendation (defer / remove / resize)

**3. CONSOLIDATIONS**
- Reviews that should merge
- What's preserved in the merge, what's dropped

**4. MISSING LENSES WITHIN EXISTING REVIEWS**
- Review name
- Missing lens
- Concrete failure the new lens would catch

**5. TIER PLACEMENT CHALLENGES**
- Review name
- Current tier
- Recommended tier
- Reasoning tied to pre-launch consumer-real-estate risk

**6. CROSS-REVIEW COORDINATION GAPS**
- Handoff that's missing
- Which reviews need it
- What bad outcome happens without it

**7. META** — one paragraph. What is the program's overall shape? What pre-launch failure modes is it best-prepared for? Where is it weakest? Any observation about the program's structure or methodology that would help the orchestrator improve it.

**Rules of engagement:**

- **Justify every proposed review against a concrete failure mode for THIS business.** "You should have a data retention audit" is useless — "Without a data retention audit, an EU visitor's right-to-be-forgotten request after launch produces an undocumented workflow that takes weeks to execute, triggering GDPR 30-day deadline breach" is useful.
- **Do not propose reviews that fit enterprise-B2B-SaaS but not pre-launch-consumer-real-estate.** No "multi-tenant architecture audit," no "SOC 2 Type II prep," no "customer success playbook" unless you can specifically justify it.
- **Do not pad.** If MISSING REVIEWS has two genuinely valuable items, that's two items. Don't invent a third.
- **Severity calibration for MISSING REVIEWS:**
  - **existential**: cease-and-desist letter, regulator fine, lawsuit, revenue-blocking outage, data breach going public. Must be Tier 1.
  - **serious**: silent bugs affecting user trust, missed revenue, operational debt that compounds post-launch but isn't legally fatal. Tier 1 or Tier 2.
  - **minor**: quality-of-life improvement, technical debt that can be addressed after the first 90 days of operational signal.
- **Respect the program's existing taxonomy:** Tier 1 = run before/at launch, Tier 2 = 90 days post-launch, Tier 3 = ongoing cadence, Tier 4 = specialty/passive. Don't invent new tiers.
- **Trust the program authors on intentional deferrals.** If an item is explicitly in "Deferred — revisit if product scope changes," don't re-propose it unless the Deferred rationale has clearly weakened.
- **Cite the tracker doc filename** when referring to a specific review's contents (e.g. "as described in `legal-compliance-audit.md`").

Your output will be consumed by a human orchestrator who will triage each proposal, not auto-executed. Signal > noise. If your best insight is that the program is mostly complete and only 1 review is genuinely missing, say so — that is a valuable finding.
