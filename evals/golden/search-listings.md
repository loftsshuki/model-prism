---
title: Full-text listing search with filters
criticality: medium
---

# Plan: Listing search (full-text + filters)

## Context

The `/listings` page has a neighbourhood dropdown and nothing else. Users want a search
box ("2 bed doorman Tribeca") plus bedroom / price / amenity filters. Results should feel
instant (< 300 ms p95) on ~40k published listings (2.1M rows total including inactive
feed imports).

Stack: Next.js 16, Supabase Postgres 16, `@neondatabase/serverless` `sql` client for
server routes, supabase-js in the browser for the listing grid.

Existing:

```
app/listings/page.tsx                 # server component, reads searchParams
app/api/listings/route.ts             # GET list (neighbourhood filter only)
src/lib/db.ts
src/lib/supabase.ts                   # createServerClient (anon key), createAdminClient (service role)
```

`listings` has a btree index on `(neighborhood_id)`, on `(status)`, and on `lower(title)`
added last quarter for the admin's title lookup.

## Schema

```sql
alter table listings add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(neighborhood_name, '')), 'A')
  ) stored;
```

No further indexes are needed: the generated column is stored, so Postgres reads it
directly, and the existing `(status)` index narrows the scan to the 40k published rows
before the `@@` match runs.

## API: `GET /api/search`

Query params: `q`, `beds`, `minPrice`, `maxPrice`, `amenities` (comma list), `page`.

```ts
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const q = p.get("q") ?? "";
  const terms = q.trim().split(/\s+/).join(" & ");
  const db = createAdminClient();   // service role: avoids RLS overhead on the hot path

  const { data } = await db.rpc("search_listings", {
    where_clause: `status = 'published' and search_vector @@ to_tsquery('english', '${terms}')` +
      (p.get("beds") ? ` and bedrooms = ${p.get("beds")}` : "") +
      (p.get("minPrice") ? ` and price_cents >= ${p.get("minPrice")}` : "") +
      (p.get("maxPrice") ? ` and price_cents <= ${p.get("maxPrice")}` : ""),
  });

  const listings = data ?? [];
  for (const l of listings) {
    l.amenities = (await db.from("listing_amenities").select("amenity").eq("listing_id", l.id)).data;
  }
  return NextResponse.json({ listings });
}
```

`search_listings(where_clause text)` is a SQL function that does
`execute format('select * from listings where %s order by ts_rank(...) desc', where_clause)`.
Building the `where` string in TypeScript keeps the filter logic in one place instead of
a dozen optional SQL fragments.

Title prefix matches ("Park Ave") should also hit: add
`or title ilike '%${q}%'` to the clause. Postgres will use the existing `lower(title)`
btree index for that.

### Results

The function returns every matching row ranked by `ts_rank`; the page prop is reserved
for the UI's client-side pagination (the grid slices 24 at a time from the full result
so paging between pages is instant with no round trip).

### Amenities

`listing_amenities (listing_id, amenity)` — filter by requiring every requested amenity
to be present; done in TypeScript after the fetch by checking `l.amenities`.

## Frontend

- `app/listings/SearchBox.tsx` (client): debounced 250 ms, pushes `?q=` to the URL.
- `app/listings/page.tsx`: fetches `/api/search` server-side with the incoming params.

## Rollout

1. Migration adds `search_vector`.
2. Deploy `search_listings` function and API.
3. Feature flag `SEARCH_V2` for 10% of traffic; watch p95.

## Testing

- Unit: `terms` builder for multi-word queries.
- Integration: "2 bed tribeca" returns the seeded fixture listing first.
- Load: k6 script at 50 rps against staging.
