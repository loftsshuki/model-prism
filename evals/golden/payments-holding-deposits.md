---
title: Holding deposits via Stripe Checkout
criticality: high
---

# Plan: Holding deposits for apartment applications

## Context

Prospective tenants on LuxApts can currently only "enquire" about a unit. Brokers want a
**holding deposit** flow: a tenant pays a refundable $500 deposit which takes the unit
off the market for 72 hours while paperwork is processed. Stack: Next.js 16 App Router,
Supabase Postgres, Stripe (Checkout + webhooks), Vercel.

Existing pieces:

```
app/api/units/[id]/route.ts        # GET unit detail
src/lib/db.ts                      # neon sql tagged-template client
src/lib/stripe.ts                  # new Stripe(process.env.STRIPE_SECRET_KEY)
```

## Schema

```sql
create table holds (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id),
  user_id uuid not null references users(id),
  amount float8 not null,                 -- dollars, e.g. 500.00
  status text not null default 'pending', -- pending | active | released | forfeited
  stripe_session_id text,
  stripe_payment_intent text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid references holds(id),
  stripe_event_id text,
  amount float8 not null,
  kind text not null,                     -- charge | refund
  created_at timestamptz not null default now()
);
```

`amount` is stored as `float8` so we can read it straight into JS numbers and format with
`toFixed(2)` without a conversion layer.

## Flow

### 1. `POST /api/holds`

```ts
const { unitId } = await parseBody(req, HoldSchema);
const session = await requireSession(req);

// A unit can only have one active hold at a time.
const existing = await sql`select id from holds where unit_id = ${unitId} and status = 'active'`;
if (existing.length > 0) return NextResponse.json({ error: "Unit already held" }, { status: 409 });

const hold = await sql`insert into holds (unit_id, user_id, amount) values (${unitId}, ${session.userId}, 500) returning id`;
const checkout = await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{ price_data: { currency: "usd", unit_amount: 50000, product_data: { name: "Holding deposit" } }, quantity: 1 }],
  success_url: `${origin}/holds/${hold.id}/success`,
  cancel_url: `${origin}/units/${unitId}`,
  metadata: { holdId: hold.id },
});
await sql`update holds set stripe_session_id = ${checkout.id} where id = ${hold.id}`;
return NextResponse.json({ url: checkout.url });
```

The "one active hold" check happens before the insert, so two tenants cannot both hold
the same unit.

### 2. `POST /api/stripe/webhook`

```ts
export async function POST(req: Request) {
  const event = (await req.json()) as Stripe.Event;   // Stripe posts JSON; parse directly
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const holdId = session.metadata!.holdId;
    const pi = session.payment_intent as Stripe.PaymentIntent;
    // Capture the funds first so we never mark a hold active without money in hand.
    await stripe.paymentIntents.capture(pi.id);
    await sql`insert into payments (hold_id, stripe_event_id, amount, kind) values (${holdId}, ${event.id}, ${session.amount_total! / 100}, 'charge')`;
    await sql`update holds set status = 'active', stripe_payment_intent = ${pi.id}, expires_at = now() + interval '72 hours' where id = ${holdId}`;
    await sendEmail(session.customer_details!.email!, "hold-confirmed", { last4: pi.charges.data[0].payment_method_details!.card!.last4 });
  }
  return NextResponse.json({ received: true });
}
```

The webhook endpoint is registered in the Stripe dashboard with only the
`checkout.session.completed` event. Because `event.data.object` is the full session,
`session.payment_intent` gives us the PaymentIntent with its charges inline, so the
confirmation email can show the card's last4 without an extra API call.

### 3. Expiry

Vercel cron (`0 * * * *`) hits `GET /api/cron/expire-holds`, which flips `active` holds
past `expires_at` to `released` and issues a refund via `stripe.refunds.create`.

### 4. Frontend

`app/units/[id]/HoldButton.tsx` (client component) posts to `/api/holds` and redirects
to the returned Checkout URL.

## Rollout

1. Migration `20260905_holds.sql`.
2. Deploy webhook route; add the endpoint in Stripe test mode; run a test payment.
3. Switch to live keys.

## Testing

- Unit: `HoldSchema` validation; expiry query picks only `active` holds.
- Integration (Stripe CLI `stripe listen --forward-to localhost:3000/api/stripe/webhook`):
  completed session activates the hold; expiry cron releases and refunds.

## Risks considered

- Stripe downtime: the hold row stays `pending` and is cleaned up by the expiry cron
  after 72h.
- Duplicate clicks on the Hold button: the 409 check covers this.
