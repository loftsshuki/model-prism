---
title: Background image processing pipeline
criticality: medium
---

# Plan: Background jobs for listing photo processing

## Context

Brokers upload 20-60 photos per listing (8-25 MB each, straight from the camera). Today
the upload route resizes them synchronously and regularly hits the request timeout.
Move resizing to a background pipeline.

Stack: Next.js 16 on Vercel (Hobby → Pro), Supabase Postgres + Storage, `sharp`.

Existing:

```
app/api/uploads/route.ts          # POST: receives file, resizes, writes to storage
src/lib/storage.ts                # putObject / deleteObject / getSignedUrl
src/lib/db.ts
vercel.json                       # { "crons": [] }
```

## Schema

```sql
create table image_jobs (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id),
  source_path text not null,        -- storage key of the original upload
  status text not null default 'queued',   -- queued | running | done | failed
  attempts int not null default 0,
  run_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now()
);
```

## Flow

### 1. Upload (`POST /api/uploads`)

- Stream the file to `uploads/originals/<listingId>/<uuid>.jpg`.
- Insert an `image_jobs` row.
- Return `202 { jobId }`. The admin UI polls `GET /api/jobs/[id]` and swaps in the thumbnail.

### 2. Worker (`GET /api/cron/process-images`)

`vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/process-images", "schedule": "* * * * *" }] }
```

Handler:

```ts
export async function GET() {
  // Grab up to 50 jobs; a minute of processing per invocation is plenty since sharp
  // resizes a 20 MB JPEG in ~2s, so 50 images ≈ 100s well within the 15-minute limit
  // Vercel gives cron functions.
  const jobs = await sql`select * from image_jobs where status = 'queued' and run_at <= now() order by run_at limit 50`;
  for (const job of jobs) {
    await sql`update image_jobs set status = 'running', attempts = attempts + 1 where id = ${job.id}`;
    try {
      const original = await storage.getObject(job.source_path);
      for (const w of [320, 800, 1600]) {
        const buf = await sharp(original).resize(w).jpeg({ quality: 82 }).toBuffer();
        await storage.putObject(derivedPath(job, w), buf);
      }
      await sql`update image_jobs set status = 'done' where id = ${job.id}`;
    } catch (e) {
      await sql`update image_jobs set status = 'failed', error = ${String(e)} where id = ${job.id}`;
    }
  }
  return NextResponse.json({ processed: jobs.length });
}
```

Vercel cron invocations are internal, so the route does not need an auth check — it is
not linked from anywhere and the path is not guessable in practice.

To scale, we can run two cron entries for the same path offset by 30 seconds, doubling
throughput; each invocation takes its own 50 queued jobs.

### 3. Storage hygiene

Originals are large and we pay per GB. Right after the job row is inserted in step 1,
delete the original from `uploads/originals/...`: the worker reads from the in-memory
buffer we still have in the upload request... no — the worker runs later, so instead
the upload route copies the original into a temp bucket `uploads/tmp/` with a 1-hour
lifecycle rule and deletes the source key immediately. The worker reads from
`uploads/tmp/`.

### 4. Failure handling

A job that throws is marked `failed` with the error string and shown in the admin as a
red badge; the broker can re-upload the photo. We do not retry automatically because
most failures are corrupt files.

### 5. Job status endpoint

`GET /api/jobs/[id]` returns `{ status, error }`. Requires a broker session.

## Rollout

1. Migration, deploy worker with cron, deploy new upload route.
2. Backfill: enqueue a job for every existing listing photo lacking a 320px derivative
   (~180k rows) in one go; the cron drains the queue over the following days.

## Testing

- Unit: `derivedPath`, resize dimensions.
- Integration: upload → job → derivatives present within 2 minutes on preview.
