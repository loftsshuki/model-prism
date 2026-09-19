# Private accounts and history recovery

Model Prism uses Clerk for sign-up, sign-in, and verified sessions. The Vercel Marketplace integration supplies separate development/preview and production credentials. Production uses Clerk's Frontend API proxy at `/__clerk`, so sign-in works on the existing `model-prism.vercel.app` domain. Workflow callbacks and the authenticated cron retain their own authentication.

## Using your account

1. Create an account or sign in from the app header.
2. Connect your OpenRouter key to run reviews. It is still your model billing credential; it is not your account identity.
3. New cloud reviews belong to your account. Sign in from another device, or replace the provider key, without losing access to those reviews.
4. In Settings, save the key used for older reviews, choose **Check previous key history**, review the counts, then choose **Import into this account**.

Imports preserve review results, spending ledgers, finding decisions, telemetry, hook jobs, and submission deduplication. Finish or stop active background jobs before importing. Each legacy capability can be linked to only one account; another account cannot claim it. Repeating an import into the same account is safe. After import the old capability cannot read account history while signed out. A signed-in request always uses its verified account and cannot switch owners with a header.

Signing out or switching accounts clears local provider credentials, cached reviews, and cached source files before showing the next session. Cloud reviews remain saved. Local checkpoints are additionally scoped by account. On a shared device, sign out when finished.

## Deployment configuration

Install Clerk through the Vercel Marketplace and pull its real `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Never publish the secret key. The app configures `/sign-in`, `/sign-up`, and the production frontend proxy itself. Do not point preview builds at the production Clerk instance.

If deploying to another domain, configure it in Clerk and update the `authorizedParties` allowlist in `src/proxy.ts`. Vercel deployment/branch URLs and the documented local verification ports are included automatically.

## Older records without ownership

Unowned records have no key-based proof of access. No public web endpoint can claim them. A deployment operator must verify ownership and select exact review IDs, then use the recovery command with the correct Clerk instance credentials and database connection. The target email must match one verified Clerk account.

```sh
# Inspect a proposed recovery; makes no ownership changes.
npm run migrate:legacy -- --env .env.recovery.local --email owner@example.com --run-ids run_one,run_two

# Apply the reviewed selection.
npm run migrate:legacy -- --env .env.recovery.local --email owner@example.com --run-ids run_one,run_two --apply
```

Recovery moves only selected unowned reviews and their associated unowned hook records, rejects records owned by another account, and records an audit entry. Standalone unowned telemetry and hook jobs have no trustworthy account association and stay private. It does not infer ownership from an email supplied by a browser, public run IDs, or the first sign-up. Production accounts and development accounts are separate.

## Verification

`npm run verify:accounts` exercises real database import transactions using synthetic records: competing account claims, active-job protection, retained decisions, capability revocation, repeated imports, and dry-run/selected unowned recovery. It removes its fixtures afterward. Clerk browser verification uses temporary accounts and real sessions, with no model requests or outbound verification email required.
