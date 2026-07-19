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
pnpm typecheck  # tsc --noEmit
```

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
