# Giro API

Hono + TypeScript backend for Giro.gtdev. Phase 2 foundation only.

## Setup

```bash
cd backend
cp .env.example .env
pnpm install
```

Repository connection uses the shared Supabase indexing-job store; there is no
in-memory runtime fallback because the API process and indexing worker must see
the same jobs. Local development therefore requires:

- `SUPABASE_URL` for an active, DNS-resolvable Supabase project.
- `SUPABASE_SERVICE_ROLE_KEY` from that project. Keep it server-only.
- The migrations in `supabase/migrations/` applied in timestamp order, including
  the `indexing_jobs` table and `create_indexing_job` RPC.

If `/repos/connect` reports unavailable indexing-job persistence, verify the
project is active and reachable, then verify the service-role key belongs to the
same project. Never put the service-role key in the frontend environment.

## Scripts

```bash
pnpm dev        # tsx watch on src/index.ts
pnpm build      # tsc -> dist
pnpm start      # node dist/index.js
pnpm indexing:worker    # continuous production indexing worker
pnpm indexing:work-once # process at most one job for debugging/recovery
pnpm typecheck  # tsc --noEmit
```

## Continuous indexing worker

Run the API and worker as separate supervised processes against the same
Supabase project. The worker uses the service-role database client and never
falls back to process memory. Set a stable, unique `INDEXING_WORKER_ID` for each
production replica.

Polling starts at `INDEXING_WORKER_POLL_INTERVAL_MS`, backs off by
`INDEXING_WORKER_IDLE_BACKOFF_MS`, and is capped by
`INDEXING_WORKER_MAX_POLL_INTERVAL_MS`. Claims are atomic in Postgres. Active
jobs update one durable heartbeat; claims older than
`INDEXING_WORKER_STALE_CLAIM_MS` are recovered with row locks.

Retryable failures are requeued with bounded exponential backoff between
`INDEXING_WORKER_RETRY_BASE_MS` and `INDEXING_WORKER_RETRY_MAX_MS`. Attempts are
durable and capped by `INDEXING_WORKER_MAX_ATTEMPTS`; invalid input,
authorization failures, and other non-retryable failures remain terminal.

On `SIGINT` or `SIGTERM`, the worker stops claiming jobs and gives the active job
up to `INDEXING_WORKER_SHUTDOWN_TIMEOUT_MS` to finish. After that timeout it
aborts the active pipeline and exits unsuccessfully so the process supervisor
can restart it; stale recovery makes the claim eligible again. Production
should use a container or process supervisor with restart-on-failure enabled.

Local development requires the same Supabase configuration as the API. Apply
all migrations, then run `pnpm indexing:worker` in a second terminal. Worker
health is written to the service-role-only `indexing_workers` table; it includes
last poll, active job, last completion, sanitized last error, and shutdown state.

## Endpoints

- `GET /` — service identity
- `GET /health` — liveness probe

Default port: `8000` (override via `PORT`).

## Response shape

```ts
type ApiResponse<T> =
  | { success: true; data: T; requestId: string }
  | { success: false; error: { code: string; message: string; details?: unknown }; requestId: string }
```
