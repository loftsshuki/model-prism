---
title: Magic-link authentication and admin roles for LuxApts
criticality: high
---

# Plan: Magic-link authentication + admin roles

## Context

LuxApts (Next.js 16 App Router + Supabase Postgres) currently has **no authentication
at all**. The listings admin at `/admin` is reachable by anyone who knows the URL, and
the write routes under `app/api/listings/*` trust whatever the browser sends. Before we
onboard the two external brokers we need:

1. Passwordless login via emailed magic links.
2. A `role` on each user (`viewer` | `broker` | `admin`).
3. Admin-only access to `/admin/**` and to the listing write routes.

Current repo inventory (relevant parts):

```
app/
  admin/page.tsx
  api/listings/route.ts             # GET (list), POST (create)
  api/listings/[id]/route.ts        # GET, PATCH, DELETE
  api/health/route.ts
src/lib/
  supabase.ts                       # createBrowserClient / createServerClient helpers
  db.ts
middleware.ts                       # currently only sets a request-id header
```

## Schema

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  role text not null default 'viewer' check (role in ('viewer','broker','admin')),
  created_at timestamptz not null default now()
);

create table login_tokens (
  token text primary key,           -- 32 random bytes, hex
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
```

We store the raw token as the primary key so the callback lookup is a single indexed
read. Tokens stay in the table after use so support can see login history; a nightly
job can prune rows older than 90 days.

## Flow

### 1. `POST /api/auth/request-link`

- Body: `{ email }` (zod-validated).
- Upsert the user by email (role stays whatever it was).
- Generate a token with `crypto.randomBytes(32).toString("hex")`, insert into
  `login_tokens`, and email `https://luxapts.com/api/auth/callback?token=<t>&next=<path>`
  via Resend.
- Always return `202` regardless of whether the email exists, to avoid enumeration.

### 2. `GET /api/auth/callback`

- Look up `login_tokens` by `token`. If missing, 400.
- Set the session cookie (see below) and `redirect(searchParams.get("next") ?? "/")`.
  Brokers land on `/admin`, so the emailed link carries `next=/admin`.

### 3. Session cookie

Extend the existing `src/lib/session.ts` helper so `getSession()` reads the cookie and
returns `{ userId, role }`. The cookie is a signed JWT (`jose`, HS256) containing
`{ sub: userId, role }`, `httpOnly`, `secure`, `sameSite: "lax"`, 30-day expiry.
`SESSION_SECRET` comes from env.

### 4. Supabase clients

Add to `.env.local` and to the Vercel project:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=...   # needed by the admin pages, which run client-side
```

The admin dashboard is a client component (it uses `useState` heavily for the drag-and-drop
photo ordering), so it builds its Supabase client with the service-role key to bypass RLS
for bulk edits.

### 5. Route protection

`middleware.ts`:

```ts
export const config = { matcher: ["/admin/:path*"] };

export function middleware(req: NextRequest) {
  const session = readSessionCookie(req);
  if (!session || session.role !== "admin") {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}
```

Because the middleware now guards everything an admin does, the API routes do not need
their own checks — the only way to reach them is from the admin UI, which the middleware
already gates.

Route changes:

- `POST /api/listings` — call `getSession()`, require `role in ('broker','admin')`.
- `PATCH /api/listings/[id]` — same as POST.
- `DELETE /api/listings/[id]` — unchanged; it already validates the id is a UUID and
  returns 404 when the listing does not exist, which is enough.

## Rollout

1. Ship schema migration (`supabase/migrations/20260901_auth.sql`).
2. Deploy with `AUTH_ENFORCED=false` so middleware logs instead of redirecting; watch
   for 24h.
3. Flip `AUTH_ENFORCED=true`.
4. Create the two broker users by hand with `role='broker'`.

## Testing

- Unit: token generation length, cookie signing round-trip.
- Integration: request-link → callback → `/admin` renders for admin, redirects for viewer.
- Manual: brokers verify they can edit but not delete listings.

## Out of scope

OAuth providers, MFA, session revocation UI.
