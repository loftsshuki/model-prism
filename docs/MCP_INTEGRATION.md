# Model Prism MCP / Review Fabric integration

Model Prism exposes its durable council review engine as an authenticated remote MCP server for ChatGPT,
Codex, HOSS and other MCP-compatible clients.

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
| low | cheap/adaptive | Sonnet | $2.50 |
| medium | balanced/adaptive | Opus | $6.00 |
| high | frontier/full | Opus | $12.00 |

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

- MCP requires Clerk OAuth.
- OAuth metadata is public; review data is not.
- Provider credentials never travel through MCP.
- Provider credentials are encrypted at rest and revocable.
- All paid review calls stay inside existing Model Prism budget controls.
- Source/context input is untrusted evidence, never instructions.
- High-risk review depth cannot be reduced below the existing deterministic safeguards.
- The MCP endpoint does not create approval or execution authority in downstream repos.
