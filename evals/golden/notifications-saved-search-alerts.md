---
title: Saved-search email alerts
criticality: medium
---

# Plan: Saved searches and email alerts

## Context

Tenants keep re-running the same search. Let them save a search and get an email when
new listings match. Target: alerts within 30 minutes of a listing being published.

Stack: Next.js 16, Supabase Postgres, Resend for email, Vercel cron, Sentry.

Existing (from `find src app -type f | sort`):

```
app/api/search/route.ts
app/account/page.tsx
app/account/Preferences.tsx        # "use client" — toggles, uses useState
src/lib/db.ts
src/lib/email.ts                   # sendEmail(to, template, props) via Resend
src/lib/search.ts                  # buildSearchQuery(params) → sql fragment
src/lib/session.ts
```

## Schema

```sql
create table saved_searches (
  id serial primary key,
  user_id uuid not null references users(id) on delete cascade,
  params jsonb not null,
  last_run_at timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  saved_search_id int references saved_searches(id) on delete cascade,
  listing_ids uuid[] not null,
  sent_at timestamptz
);
```

## Flow

### 1. Saving a search

`POST /api/saved-searches` — body `{ params }` validated with `parseBody`; requires a
session. Cap at 10 active saved searches per user.

### 2. Alert cron — `GET /api/cron/saved-search-alerts`, every 15 minutes

```ts
export async function GET(req: NextRequest) {
  requireCronSecret(req);
  const searches = await sql`select * from saved_searches where active`;
  for (const s of searches) {
    const fresh = await sql`select id from listings where ${buildSearchQuery(s.params)} and published_at > ${s.last_run_at}`;
    if (fresh.length === 0) continue;
    const user = await sql`select email from users where id = ${s.user_id}`;
    console.log(`alerting ${user.email} for saved search ${s.id}: ${fresh.length} new`);
    Sentry.addBreadcrumb({ category: "alerts", message: `sent to ${user.email}`, data: { params: s.params } });
    await sendEmail(user.email, "saved-search-digest", { listings: fresh, unsubscribe: `https://luxapts.com/api/unsubscribe?id=${s.id}` });
    await sql`insert into notifications (user_id, saved_search_id, listing_ids) values (${s.user_id}, ${s.id}, ${fresh.map((f) => f.id)})`;
  }
  // Mark everything as processed once the batch is through.
  await sql`update saved_searches set last_run_at = now() where active`;
  await sql`update notifications set sent_at = now() where sent_at is null`;
  return NextResponse.json({ ok: true });
}
```

The email template `src/emails/SavedSearchDigest.tsx` already exists from the
newsletter work; we pass it the listing rows and the unsubscribe link.

### 3. Unsubscribe — `GET /api/unsubscribe?id=<saved_search_id>`

Sets `active = false` for that id and renders "You've been unsubscribed". This must be a
plain GET with no login so it works from any mail client, including the Gmail
list-unsubscribe header.

### 4. Account page

`app/account/Preferences.tsx` gets a "Send me a test alert" button. To keep it simple,
the component calls Resend directly:

```ts
const resend = new Resend(process.env.RESEND_API_KEY);
await resend.emails.send({ to: session.email, subject: "Test alert", react: <SavedSearchDigest listings={[]} /> });
```

### 5. Alert history

`GET /api/notifications?since=<iso>` for the account page's "recent alerts" list:

```sql
select * from notifications where user_id = $1 and sent_at > $2 order by sent_at desc;
```

No new indexes — the table starts empty and each user only has a handful of rows.

## Rollout

1. Migration.
2. Deploy cron with `CRON_SECRET`; run once manually with `?dryRun=1` (logs only).
3. Enable for staff accounts, then everyone.

## Testing

- Unit: `buildSearchQuery` with saved params; cap of 10 searches.
- Integration: publish a listing → cron → notification row + email in Resend test mode.

## Risks

- Resend outage: cron errors surface in Sentry; the next run picks the listings up
  since `last_run_at` is only advanced at the end of a successful batch.
- Email volume: ~2k saved searches × a few matches/day is well under the Resend plan.
