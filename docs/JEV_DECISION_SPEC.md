# Jev Decision Spec v1

Canonical version: `jev-decision-spec/v1`

Model Prism is the canonical home for the fleet-wide Jev decision contract. The
contract is provider-agnostic: Jev currently supplies the bounded judgments, but
the resolution semantics live in code and are shared across repos.

Reference implementations:

- TypeScript: `src/lib/jev-decision-kit.ts`
- Python: `reference/python/jev_decision_kit.py`
- Telemetry schema: `spec/jev-decision.schema.json`

## The primitives

### Classify

Answer: **What is this?**

Examples:
- lead intent
- email type
- content format
- finding category
- memory type

Assist records the classification but does not silently replace an existing
deterministic class. Enforce may make a confident Jev classification authoritative.
Routing and gating can consume classifications to add scrutiny.

### Verify

Answer: **Does it satisfy the definition of done?**

Canonical decisions:

`pass < review < fail`

Assist may only move upward toward more scrutiny. Enforce may move either direction
when confident, but never below a configured `hardFloor`.

Examples:
- complete thought?
- required context present?
- evidence adequate?
- visual proof needed?
- persona/brand fit acceptable?

### Gate

`Gate` is an alias of Verify for workflows whose natural vocabulary is
pass/review/fail.

### Dedupe

Answer: **How novel is this relative to existing work?**

Recommended default order:

`new < adjacent < update_existing < near_duplicate < duplicate < contradiction`

A repo may use another explicit order. Assist may only move toward the more
conservative end of that order. Enforce may move either direction while respecting
a hard floor.

A good dedupe evaluation also records:
- closest existing item ID
- whether the new candidate is meaningfully better
- whether it updates or contradicts existing state

### Rank

Answer: **How strong is this candidate relative to peers?**

Assist may promote but never demote the deterministic score. Enforce may use a
confident Jev score in either direction.

Rank does not establish factual eligibility. Deterministic checks happen first.

### Shortlist

Answer: **Does this candidate deserve expensive downstream work?**

Assist uses a union:

`baseline shortlist ∪ confident Jev additions`

It cannot silently remove baseline-selected work.

Enforce may add or remove confident candidates. `hardSelected` candidates can
never be removed.

### Route

Answer: **Where should this go next?**

Each workflow supplies an explicit least-to-most-expensive/scrutinized route ladder,
for example:

`deterministic < cheap-model < strong-model < human`

Assist may only move upward. Enforce may move either direction but never below a
configured `hardFloor`.

This is the standard budget-router primitive.

## Mode contract

### Off
No Jev influence. Repos should avoid the Jev call entirely when practical.

### Shadow
Run Jev and persist telemetry. Effective behavior remains baseline.

### Assist
One-way safety mode:
- add scrutiny
- promote promising work
- rescue baseline work
- add shortlist candidates
- escalate routing

Assist must not:
- silently discard baseline work
- reduce required review
- lower a hard route floor
- override factual/deterministic eligibility

### Enforce
Confident Jev decisions may become authoritative within the bounded primitive.

Hard deterministic floors/selections still win.

Low confidence and provider failure fall back to baseline.

## Candidate-explosion pipeline

The preferred fleet-wide pattern is:

```text
generate many candidates
        ↓
deterministic eligibility / hard rules
        ↓
Jev Classify + Verify + Dedupe
        ↓
Jev Rank + Shortlist
        ↓
expensive model / agent
        ↓
deterministic validation
        ↓
human for irreversible/high-risk actions
```

The economic goal is not merely to inspect work after expensive models have
already run. The goal is to reduce how much work reaches expensive intelligence.

## Budget router

A workflow should define its own route ladder, for example:

```text
Tier 0: deterministic code
Tier 1: Jev
Tier 2: cheap LLM / automation
Tier 3: strong LLM / coding agent
Tier 4: human
```

Jev confidence itself is a routing signal. Low confidence should normally escalate,
not be converted into false certainty.

## Telemetry

Every decision emits the schema in `spec/jev-decision.schema.json`.

Minimum fields:
- specVersion
- primitive
- key
- mode
- baselineDecision
- effectiveDecision
- action

Recommended fields:
- answer
- confidence
- probabilities
- latencyMs
- costUsd
- generationId
- evaluatorVersion
- error

Outcome systems should later attach business/quality results to the decision ID or
source record so the fleet can measure:
- human override rate
- false positive / false negative rate
- expensive-model calls avoided
- cost avoided
- latency saved
- downstream quality changes

## Provider boundary

The current Jev implementation uses TypeSafe AI Jev through Vercel AI Gateway.

Recommended request properties:
- `typesafe-ai/jev`
- native `/v1/evaluate`
- Zero Data Retention
- TypeSafe-only provider routing
- bounded typed questions

The provider is not the policy layer. The shared resolver functions are.

## Safety boundary

Keep these deterministic or human-controlled:
- factual availability
- rights/licensing authority
- security/auth/payment hard rules
- destructive data actions
- legal/compliance authority
- housing eligibility / protected-class-sensitive decisions
- hiring selection decisions
- irreversible publication or spend where policy requires a human

Jev may classify or surface missing information around such workflows, but it is
not the sole authority.

## Recommended fleet rollout

Highest leverage retrofit order:

1. AutoSweep: finding dedupe + shortlist before coding agents
2. NameMint: pre-registrar shortlist + post-registrar ranking
3. LuxuryApartments: opportunity dedupe + content shortlist
4. WorkBrain / Brain: novelty class + update/contradiction routing
5. Synthetic Creator Studio: hook/clip shortlist + definition-of-done verification
6. Kompound: creative hypothesis shortlist before production
7. Mashups: suggestion and arrangement ranking after deterministic rights/compatibility
