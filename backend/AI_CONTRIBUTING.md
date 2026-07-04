# AI Contributor Guide — Giro.gtdev

Giro.gtdev is an Engineering Intelligence Platform for GitHub repositories.

It is not a generic AI coding assistant.

The system builds deterministic repository understanding before any LLM output.

Core pipeline:

Repository
→ Structure Analysis
→ Architecture Analysis
→ Symbol Extraction
→ Dependency Graph
→ Hybrid Retrieval
→ Context Assembly
→ Answer Generation
→ Repository Intelligence Dashboard

## Engineering Principles

- Deterministic logic first.
- LLMs only after deterministic retrieval.
- No randomness.
- No hidden global state.
- No unrelated refactors.
- No dead code.
- No duplicate services when existing services can be extended.
- Prefer composition over duplication.
- Keep routes thin and services smart.
- Preserve strict TypeScript.
- Add focused tests for every behavior change.
- Run typecheck and tests before considering work complete.

## Before Editing

Every AI agent must first inspect:

- `spec.md`
- `tasks.md`
- `PRODUCTION-ROADMAP.md`
- relevant route/service/test files

Then summarize:

1. What the requested change means.
2. Which files are relevant.
3. What extension point will be used.
4. What should not be changed.

## Change Rules

AI agents must not:

- rename public APIs without instruction
- change response contracts casually
- introduce new dependencies without approval
- move large files unnecessarily
- create wrapper services without clear product value
- touch screenshots, local notes, or unrelated markdown files
- commit automatically

## Testing Standard

Before handoff, run:

```bash
npx tsc --noEmit
pnpm vitest run