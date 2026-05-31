# Model Prism Upgrade Plan

A phased plan for upgrading Model Prism from a multi-model prompt/review tool into a reusable review cockpit for projects like LuxuryApartments, Pi Desktop, and Model Prism itself.

---

## Phase 1 — Product foundation ✅ Basic Done

### 1. Project profiles ✅ Basic Done

Goal: save repeatable project-specific defaults.

Add:

- Project name
- Default repo/context pack
- Default roster
- Default synthesis model
- Default prompt preset
- Saved admin/API settings reference

Example profiles:

- `LuxuryApartments`
- `Pi Desktop`
- `Model Prism`

Likely files:

```text
src/lib/types.ts
src/lib/project-profiles.ts
src/app/settings/page.tsx
src/app/page.tsx
```

---

### 2. Run presets ✅ Basic Done

Goal: make common review types one-click.

Presets:

- Plan review
- Code review
- Security review
- Product critique
- Architecture review
- Debugging council

Each preset sets:

- Prompt template
- Recommended roster
- Synthesis instructions
- Optional context expectations

---

### 3. Cost controls ✅ Basic Done

Goal: prevent surprise spending.

Add:

- Estimated cost before run
- Hard max budget per run
- Warning modal for expensive runs
- Actual vs estimated cost after run
- Per-profile default budget

---

## Phase 2 — Better review outputs ✅ Basic Done

### 4. Review quality scoring ✅ Basic Done

Goal: help judge whether the review was useful.

Score:

- Fatal flaws found
- Actionability
- Coverage
- Disagreement level
- Confidence
- Missing-context risk

Example output:

```text
Review Quality: 82/100
Risk: Medium
Actionability: High
```

---

### 5. Action item extractor ✅ Basic Done

Goal: turn synthesis into tasks.

Extract:

- TODO checklist
- Risks
- File-specific action items
- Suggested owner/agent
- “Must fix before approval” items

Export as:

- Markdown
- JSON
- Copyable checklist

---

### 6. Second-pass review button ✅ Basic Done

Goal: critique the synthesis itself.

Flow:

1. Run normal council
2. Generate synthesis
3. Click **Second Pass**
4. Different prompt and possibly different models review:
   - assumptions
   - missed risks
   - weak recommendations
   - contradictions

---

## Phase 3 — Model intelligence ✅ Basic Done

### 7. Model leaderboard ✅ Basic Done

Goal: know which models are worth paying for.

Track:

- Unique high-value insights
- Agreement with final synthesis
- Failure rate
- Average latency
- Average cost
- Cost per useful insight

Views:

```text
Best value
Most unique insights
Most reliable
Most expensive low performers
```

---

### 8. Model failure diagnostics ✅ Basic Done

Goal: make flaky models obvious.

Track:

- 429 rate limits
- 503/no provider
- Empty response
- Bad structured output
- Timeout
- Fallback usage

Example recommendation:

```text
Replace GLM 4.5 Air free: 42% fallback rate
```

---

### 9. Auto roster recommendations ✅ Basic Done

Goal: let telemetry improve default rosters.

Use leaderboard + diagnostics to suggest:

- Remove weak model
- Replace flaky model
- Use cheaper equivalent
- Add underrepresented model family

Keep this manual approval only.

---

## Technical debt / revisit notes

- Resolved: web telemetry now stores records in the database-backed `run_telemetry` table so `next build` no longer warns about filesystem tracing. CLI plan reviews still keep a local JSONL ledger via `src/lib/telemetry-ledger.ts` for offline reports.
- Hardening pass completed: live hook jobs API/dashboard, DB-backed plan statuses, GitHub-ready PR review export, local context replacement controls, synthesis compare tests, CI workflow, and expanded deployment docs.

---

## Phase 4 — Context upgrades ✅ Basic Done

### 10. Context pack templates ✅ Basic Done

Goal: make context setup fast.

Templates:

- Next.js app
- Supabase backend
- AI infra/tooling
- Marketing/content site
- Security review
- PR review

Each suggests files to include:

```text
package.json
AGENTS.md
README.md
src/lib/*
src/app/api/*
docs/setup/*
```

---

### 11. Local file context ✅ Basic Done

Goal: use local files, not only GitHub.

Add:

- Attach local files/folders
- Save local context pack
- Secret/binary filtering
- Size limits
- Windows path support

This overlaps with the Pi Desktop file attachment work.

---

### 12. Compare synthesis versions ✅ Basic Done

Goal: show differences between reruns.

For same input/plan:

- Compare old synthesis vs new synthesis
- Show new risks
- Show removed risks
- Show changed recommendations
- Note model roster changes

Useful after plan edits.

---

## Phase 5 — Workflow integration ✅ Basic Done

### 13. Plan approval workflow ✅ Basic Done

Goal: make reviewed plans operationally clear.

Statuses:

```text
Draft
Council reviewed
Needs changes
Founder approved
Ready for execution
Executed
```

Support frontmatter:

```yaml
reviewed-at:
approved-at:
review-model:
roster:
criticality:
```

---

### 14. GitHub PR integration ✅ Basic Done

Goal: review PR diffs directly.

Add:

- Paste PR URL
- Fetch diff via GitHub API
- Run code review preset
- Export review markdown
- Later: comment on PR manually/automatically with confirmation

---

### 15. Plan-review hook dashboard ✅ Basic Done

Goal: see live hook/council activity.

Dashboard:

- Pending reviews
- Running reviews
- Completed reviews
- Failed reviews
- Cost
- Models used
- Linked plan file
- Logs/errors

Especially useful for:

```text
C:/Dev/LuxuryApartments
```

---

## Recommended build order

```text
1. Project profiles
2. Run presets
3. Cost controls
4. Action item extractor
5. Review quality scoring
6. Second-pass review
7. Model leaderboard
8. Failure diagnostics
9. Context pack templates
10. Local file context
11. Plan approval workflow
12. Compare synthesis versions
13. PR integration
14. Plan-review hook dashboard
15. Auto roster recommendations
```

---

## First milestone

### Milestone 1 — Make Model Prism reusable per project ✅ Basic Done

Built:

- Built-in project profiles for LuxuryApartments, Pi Desktop, and Model Prism
- Custom project profiles in Settings using localStorage
- Run presets for plan review, code review, security review, product critique, architecture review, and debugging council
- Cost budget control with warning confirmation before expensive runs

Why first:

- Biggest usability jump
- Low risk
- Makes the existing tool more repeatable before adding complex intelligence
