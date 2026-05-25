# Giro API

Hono + TypeScript backend for Giro.gtdev. Phase 2 foundation only.

## Setup

```bash
cd backend
cp .env.example .env
pnpm install
```

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
