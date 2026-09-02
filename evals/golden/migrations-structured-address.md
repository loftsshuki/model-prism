---
title: Structured addresses and price display migration
criticality: medium
---

# Plan: Migrate listings to structured addresses

## Context

`listings.address_raw` is a free-text column ("12 Park Row, Apt 4B, New York, NY 10038")
that brokers type by hand. Map pins, neighbourhood filters and the new "nearby" module
all need structured fields. We also want to retire `price_text` ("$4,200/mo") in favour
of an integer `price_cents` plus a generated display string.

Facts:

- `listings` has ~2.1M rows (we import the whole StreetEasy feed nightly, most rows are
  inactive). ~40k are `status = 'published'`.
- Postgres 16 on Supabase; migrations run via `supabase db push` inside a single
  transaction per file.
- The web app is deployed on Vercel with rolling deploys; old and new lambdas overlap for
  a few minutes.
- The public listing page query today is:

  ```sql
  select * from listings
  where neighborhood_id = $1 and status = 'published'
  order by published_at desc
  limit 24;
  ```

  Currently backed by a single-column index on `neighborhood_id`.

## Migration `20260910_structured_address.sql`

```sql
begin;

alter type listing_status add value 'archived';

alter table listings
  add column street text,
  add column unit text,
  add column city text,
  add column state char(2),
  add column postal_code text,
  add column geo point,
  add column price_cents bigint not null default 0,
  add column price_display text generated always as
    ('$' || to_char(price_cents / 100.0, 'FM999,999,999') || '/mo') stored;

-- Old feed rows that never went live are dead weight; archive them so the parser
-- only has to deal with real listings.
update listings set status = 'archived' where status = 'imported' and published_at is null;

alter table listings rename column price_text to price_text_legacy;
alter table listings drop column address_raw;

alter table listings alter column postal_code type varchar(10);

commit;
```

The parsing of the old free-text addresses into the new columns happens in the app: the
`src/lib/address-parser.ts` module (new, ~150 LOC using `parse-address`) runs when a
broker next opens a listing in the admin and saves it. Published listings get re-saved
by brokers naturally over the next few weeks.

## Application changes

- `src/lib/listings.ts`: read the new columns; `priceDisplay` comes from
  `price_display`, `priceText` is removed. All call sites (`app/listings/[id]/page.tsx`,
  `app/api/listings/route.ts`, `components/ListingCard.tsx`) switch in the same PR.
- `src/lib/address-parser.ts`: new.
- Nightly importer (`scripts/import-feed.ts`): write structured columns directly from
  the feed's structured fields.
- Neighbourhood pages: no query changes needed; the `neighborhood_id` index still applies.

## Rollout

1. Merge the app PR.
2. Run the migration against production at 10:00 ET Friday (brokers are lightest on
   Fridays) with `supabase db push`.
3. Deploy the app.
4. Monitor Sentry for `column "price_text" does not exist` for 30 minutes.

There is no down migration: the change is a one-way improvement and we do not expect to
revert. If something goes badly wrong we can restore from the nightly Supabase backup
(taken at 03:00 ET).

## Testing

- `address-parser.test.ts` with 40 sample addresses from the feed.
- Staging dry-run of the migration against a 100k-row sample.

## Open questions

- Should `geo` be PostGIS `geography` instead of `point`? Decided: `point` for now,
  we only need bounding-box queries.
