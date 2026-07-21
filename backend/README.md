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

## Repository storage security

Set `REPOSITORY_STORAGE_ROOT` to a dedicated absolute directory in production.
Startup rejects an empty value, `/`, relative production paths, and the local
development default. Giro canonicalizes and creates the root deliberately, then
derives each checkout as `repo-<sha256(repository-id)>`; owner and repository
display names are never used as directory fragments. Absolute checkout paths
are internal and are not returned by the API.

Every repository API operation authorizes the authenticated user against the
durable repository record before services receive repository identity or a
checkout. Session operations additionally revalidate both session ownership and
the session's durable repository. The indexing worker applies the same durable
boundary to claimed jobs: repository ID, owner/name, owning user, and source URL
must all match before repository state or the filesystem is touched.

Repository scans skip directory and file symlinks. A direct file read may follow
an internal symlink only after `realpath` proves its target remains inside the
authorized checkout; external and broken symlinks are rejected. Cleanup accepts
only the exact server-derived checkout, rejects the storage root and parents,
and removes a nested symlink itself without following its target. Git fetch,
checkout, reset, and clean run only after the checkout, `.git` location, and Git
top-level have been validated against that exact checkout.

## Scripts

```bash
pnpm dev        # tsx watch on src/index.ts
pnpm build      # tsc -> dist
pnpm start      # node dist/index.js
pnpm indexing:worker:dev    # tsx watch worker for local development
pnpm indexing:worker        # node dist/commands/runIndexingWorker.js
pnpm indexing:work-once:dev # one job directly from TypeScript
pnpm indexing:work-once     # one job from compiled JavaScript
pnpm typecheck  # tsc --noEmit
pnpm test:postgres          # disposable real-Postgres integration suite
pnpm verify:migrations      # apply and re-verify the complete migration chain
pnpm validate:production    # build, typecheck, unit, Postgres, and migration checks
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
all migrations, then run `pnpm indexing:worker:dev` in a second terminal. For
production, run `pnpm build`, install production dependencies, and supervise
`pnpm indexing:worker` (or `pnpm start:worker`). Both production commands execute
only `dist/commands/runIndexingWorker.js`; `tsx` is not a runtime dependency. Worker
health is written to the service-role-only `indexing_workers` table; it includes
last poll, active job, last completion, sanitized last error, and shutdown state.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm prune --prod
pnpm start:worker
```

## PostgreSQL integration validation

The PostgreSQL integration suite creates a uniquely named disposable database,
applies every file in `supabase/migrations/` in timestamp order, runs the live
schema and concurrency checks, and drops the database after each test. The
configured account must be able to create and drop databases, terminate sessions
to its disposable databases, create extensions, and `SET ROLE` to `anon`,
`authenticated`, and `service_role`. Those roles must already exist on the test
cluster, and `vector` plus `pg_trgm` must be available.

Set `GIRO_POSTGRES_TEST_URL` to an administrative database dedicated to tests.
Its database name must contain `test`; non-loopback hosts are rejected unless
`GIRO_POSTGRES_ALLOW_REMOTE_TEST_HOST=1` is also set. Never use a production URL
or production credentials.

```bash
export GIRO_POSTGRES_TEST_URL=postgresql://postgres:postgres@127.0.0.1:5432/giro_test_admin
pnpm test:postgres
pnpm verify:migrations
```

When the URL is absent locally, both commands exit successfully with an explicit
skip reason. CI that requires the database boundary must also set
`GIRO_POSTGRES_INTEGRATION_REQUIRED=1`; a missing URL, unreachable server,
missing role, missing extension, migration failure, or cleanup failure then
fails the job. `pnpm validate:production` runs the complete production
validation sequence.

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
