# API Route Prompt — Giro.gtdev

You are implementing or modifying an API route in Giro.gtdev.

## Project Rules

Routes should be thin.

Business logic belongs in services.

Use existing helpers:

- `ok`
- `fail`
- logger
- auth helpers
- ownership guards
- Zod validation patterns

## Objective

`[INSERT ROUTE CHANGE HERE]`

## Inspect First

- route file being changed
- related service
- existing route tests
- response helper
- auth/ownership middleware

## Requirements

- Validate input.
- Use consistent error codes.
- Preserve ownership/security checks.
- Return frontend-friendly response.
- Add route-level test if this route is externally consumed.

## Do Not

- duplicate business logic inside route
- bypass auth/ownership checks
- change unrelated routes
- invent a new response shape if one already exists

## Verification

Run:

```bash
npx tsc --noEmit
pnpm vitest run