# Model Prism MCP / Review Fabric integration

Model Prism exposes its durable council review engine as an authenticated remote MCP server for ChatGPT,
Codex, HOSS and other MCP-compatible clients.

## ChatGPT OAuth discovery compatibility

The MCP transport is authentication-required from the first GET/POST request. Unauthenticated probes receive `401 Unauthorized` with a `WWW-Authenticate` challenge pointing at the root RFC 9728 protected-resource metadata URL:

```text
https://model-prism.vercel.app/.well-known/oauth-protected-resource
```

Model Prism also serves the same document at the RFC 9728 path-aware URL for the `/api/mcp` resource (`/.well-known/oauth-protected-resource/api/mcp`) and at the older `/.well-known/oauth-protected-resource/mcp` alias, so clients that skip the challenge and derive the URL still find it. All three identify the authorization server, advertise the required scopes, and declare header-based bearer tokens. This matches ChatGPT's current OAuth discovery flow while preserving the path-aware MCP metadata form.

The authorization server is `https://<deployment>/__clerk` for a production (`pk_live_`) Clerk key, where the `/__clerk` Frontend API proxy runs. With a development (`pk_test_`) key the proxy is off, so the metadata names the Clerk Frontend API host encoded in the publishable key instead. `MODEL_PRISM_OAUTH_AUTHORIZATION_SERVER` overrides both.

### Restricting which OAuth clients may call MCP

Any client a user authorizes in Clerk can obtain a token for `/api/mcp`. To pin access to known agents, set a comma-separated allowlist of Clerk OAuth client ids:

```env
MODEL_PRISM_MCP_ALLOWED_CLIENT_IDS=<chatgpt-client-id>,<claude-client-id>
```

Tokens from any other client then receive the normal `401` challenge. While the variable is unset, all consented clients are accepted and the server logs each client id the first time it is seen (`[mcp] OAuth client in use: …`), which is the easiest way to collect the ids before turning the allowlist on.

## Endpoint

```text
https://model-prism.vercel.app/api/mcp
```

OAuth protected-resource discovery:

```text
https://model-prism.vercel.app/.well-known/oauth-protected-resource/mcp
```

The MCP resource server uses the existing Model Prism Clerk account boundary. Clerk remains the OAuth
authorization server through the production frontend proxy at:

```text
https://model-prism.vercel.app/__clerk
```

The MCP endpoint never accepts or returns an OpenRouter key.

## Tools

### `review_plan`

Starts a durable background Model Prism council review.

Input includes:

- frozen plan/spec text;
- artifact type;
- criticality;
- project key;
- optional bounded context;
- optional source documents;
- optional review budget ceiling.

Review depth is risk-adaptive:

| Criticality | Council | Synthesis | Default max cost |
| --- | --- | --- | ---: |
| low | cheap/adaptive | Fable 5.1 | $2.50 |
| medium | balanced/adaptive | Fable 5.1 | $6.00 |
| high | frontier/full | Fable 5.1 | $12.00 |

Synthesis uses Claude Fable 5.1 and falls back to Opus 5.5, then Sonnet 5.5, when Fable is unavailable or
lacks tool support. A `maxCost` too small to cover the council plus the smallest synthesis is rejected
with a 400 before any spend. When the remaining budget cannot cover the full synthesis output, the
synthesis output allowance shrinks to fit (never below 8,192 tokens) instead of failing.

An identical retry with the same submission ID returns the existing run, even if the live catalog has
changed since the first attempt. A saved review whose workflow never started is dispatched again on the
next retry or status read.

High-risk reviews always use the full selected council. All review runs preserve the existing durable
budget, replay, cancellation, lease and workflow semantics.

### `get_review`

Reads review status and the synthesized result. Raw individual model responses are omitted by default and
may be requested explicitly.

### `list_reviews`

Lists recent durable reviews for the authenticated Model Prism account.

### `stop_review`

Requests cancellation of a running review. Completed responses and recorded spending remain retained under
the existing background-review semantics.

## Account / provider credential boundary

Browser Model Prism reviews historically use the user's OpenRouter key from browser storage, and a
background review stores an encrypted copy only for the lifetime of that review.

MCP has no browser localStorage, so signed-in users may explicitly enable **ChatGPT / agent review access**
from Model Prism Settings. Enabling it:

1. takes the currently connected OpenRouter key from the browser;
2. validates it directly with OpenRouter;
3. encrypts it with `MODEL_PRISM_ENCRYPTION_KEY`;
4. stores only the encrypted credential + last four characters in Neon;
5. binds it to the hashed Clerk account owner;
6. never returns the provider key through MCP or an API response.

The saved credential can be refreshed or revoked from Settings at any time. At review dispatch, Model Prism
revalidates the credential and copies it into the existing 24-hour encrypted review-job credential lease.

This is deliberately opt-in. Signing into Model Prism does not automatically persist a provider credential.

## OAuth consent route

The production Clerk instance cannot use its hosted Account Portal while Model Prism is served only from a `vercel.app` domain. Model Prism therefore hosts Clerk's prebuilt OAuth consent UI at:

```text
https://model-prism.vercel.app/oauth-consent
```

In Clerk Dashboard → **Configure → Paths**, set the production **OAuth consent** location to that full HTTPS URL. Keep the OAuth consent screen enabled for CIMD clients. The route uses Clerk's `<OAuthConsent />` component, preserves allow/deny behavior and requested-scope rendering, sets a strict referrer policy, and suppresses unrelated Model Prism navigation while consent is shown.

## One-time Clerk setting

The production Clerk application must publish OAuth Client ID Metadata Document (CIMD) support so ChatGPT
can identify itself as a public OAuth client without a stored client secret.

In Clerk Dashboard:

1. Open **OAuth applications → Settings**.
2. Enable **Publish CIMD support**.
3. Keep PKCE/S256 enabled.
4. Allow the standard scopes used by this server:
   `openid profile email offline_access`.
5. For the tightest posture, use pre-registered-client admission and allow ChatGPT's production CIMD client.

Do not enable Dynamic Client Registration unless another client actually requires it.

## Account deletion and bans (Clerk webhook)

Review Fabric service tokens, the stored MCP OpenRouter credential, and background reviews keep working without a Clerk session. To cut them off when an account is deleted, banned, or locked:

1. In Clerk Dashboard → **Webhooks**, add an endpoint `https://model-prism.vercel.app/api/webhooks/clerk` subscribed to `user.deleted` and `user.updated`.
2. Copy its signing secret into the deployment as `CLERK_WEBHOOK_SIGNING_SECRET`.

On those events Model Prism revokes every service token for the account, deletes its stored MCP provider credential, and stops its active background reviews. Saved review history is kept. Without the secret the endpoint answers `503` and does nothing.

## ChatGPT connection

After the deployment is live and the Clerk CIMD setting is enabled:

1. Sign in to Model Prism.
2. In **Settings**, save the normal OpenRouter key.
3. Choose **Enable agent access**.
4. In ChatGPT developer/plugin settings, create a custom MCP app using:
   `https://model-prism.vercel.app/api/mcp`.
5. Complete the Clerk OAuth prompt.
6. Scan/enable the tools.

A new ChatGPT session should then expose the Model Prism tools.

## HOSS service-to-service Review Fabric

Interactive MCP OAuth remains the user-facing path. Unattended HOSS reviews use a separate owner-bound service token instead of automating a Clerk browser session.

### Create the token

A signed-in Model Prism account with agent review access enabled can create a HOSS token from **Settings → HOSS / service review access**.

The plaintext token is shown once and uses the form:

~~~text
mp_svc_<high-entropy-secret>
~~~

Model Prism stores only the token hash, owner binding, label, scopes, creation time, last-used time, and revocation time. HOSS stores the plaintext token only in host secret configuration.

Scopes are:

~~~text
reviews:start
reviews:read
reviews:stop
~~~

Revoking the service token does not delete completed reviews.

### Service API

Start:

~~~http
POST /api/review-fabric/v1/reviews
Authorization: Bearer mp_svc_...
Idempotency-Key: <ReviewRequest.idempotencyKey>
Content-Type: application/json
~~~

The body is a strict envelope:

~~~json
{
  "request": {
    "schemaVersion": 1,
    "requestId": "review-request:<sha256>",
    "artifactId": "review-artifact:<sha256>",
    "artifactContentSha256": "<sha256>",
    "provider": "model-prism",
    "projectId": "hoss",
    "repository": "loftsshuki/HOSS",
    "artifactType": "implementation_plan",
    "criticality": "medium",
    "contextCapsuleId": "ctx_...",
    "contextSha256": "<sha256>",
    "repositoryBasis": {
      "commitSha": "<40-char-git-sha>",
      "observedAt": "2026-09-28T20:00:00.000Z"
    },
    "policyRevision": "<sha256>",
    "budget": { "maxCostUsd": 6 },
    "additionalInstructions": "",
    "idempotencyKey": "<sha256>",
    "requestedAt": "2026-09-28T20:01:00.000Z",
    "requestedBy": { "actorType": "service", "actorId": "hoss" }
  },
  "artifact": {
    "title": "Implementation plan",
    "content": "exact frozen artifact bytes as UTF-8 text"
  },
  "context": {
    "text": "exact Context Capsule rendering used for this review",
    "completeness": "complete"
  },
  "sources": []
}
~~~

Model Prism recomputes the artifact and context SHA-256 values before dispatch. A mismatch is rejected.

The HTTP Idempotency-Key must equal the request field. Model Prism binds that stable key to the existing durable submission ledger. An identical retry returns the existing run; reusing the key for changed review input is a conflict. This prevents ambiguous network failures from creating a second paid council.

Read:

~~~http
GET /api/review-fabric/v1/reviews/:providerRunId
Authorization: Bearer mp_svc_...
~~~

The read result is normalized for HOSS and includes run state, timestamps, cost, roster, synthesis model, disposition, finding counts, bounded material findings, synthesis Markdown/hash, context completeness, and the original HOSS request/artifact/basis references.

The service endpoint exposes only runs created through the HOSS Review Fabric service path. A service token cannot use this route to read ordinary browser or OAuth-MCP reviews.

Stop:

~~~http
POST /api/review-fabric/v1/reviews/:providerRunId/stop
Authorization: Bearer mp_svc_...
~~~

Cancellation reuses the existing durable stop semantics. Completed responses and provider-accepted spending remain retained.

### Credential boundary

The HOSS token does not contain or reveal the OpenRouter credential.

At dispatch:

1. service token resolves to the owning Model Prism account;
2. Model Prism loads that account's encrypted agent-access OpenRouter credential;
3. Model Prism revalidates the provider credential;
4. the existing background-review machinery receives its normal temporary encrypted job lease;
5. HOSS sees only Model Prism review IDs and normalized results.

## Portfolio placement

Model Prism remains a standalone **Review Fabric**. HOSS decides when an artifact is review-ready and can
supply Repo Lens / Brain / workflow context. Model Prism owns council execution, synthesis, findings,
budgets and review telemetry. Brain receives only adjudicated durable review learnings, not raw council
output.

The intended portfolio gate is:

```text
draft spec
 -> ready_for_review
 -> Model Prism ReviewReceipt
 -> revise/adjudicate
 -> founder-approved spec
 -> implementation plan
 -> Model Prism ReviewReceipt
 -> ready_for_execution
 -> build
 -> plan-vs-reality review
```

A review is bound to the exact frozen content that Model Prism stores in the durable run. If the artifact
changes materially, start a new review rather than reusing the old receipt.

## Security invariants

- MCP requires Clerk OAuth; `MODEL_PRISM_MCP_ALLOWED_CLIENT_IDS` can restrict which OAuth clients are accepted.
- Deleting, banning, or locking a Clerk user revokes service tokens and the MCP credential and stops running reviews (requires the Clerk webhook).
- OAuth metadata is public; review data is not.
- Provider credentials never travel through MCP.
- Provider credentials are encrypted at rest and revocable.
- All paid review calls stay inside existing Model Prism budget controls.
- Source/context input is untrusted evidence, never instructions.
- High-risk review depth cannot be reduced below the existing deterministic safeguards.
- The MCP endpoint does not create approval or execution authority in downstream repos.
