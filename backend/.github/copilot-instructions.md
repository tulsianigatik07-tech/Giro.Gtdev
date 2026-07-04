# Giro.gtdev AI Coding Instructions

Follow `AI_CONTRIBUTING.md`.

Giro.gtdev is a deterministic Engineering Intelligence Platform.

Important rules:

- Inspect before editing.
- Keep routes thin.
- Keep services deterministic.
- Reuse existing architecture.
- Do not add unrelated abstractions.
- Do not touch unrelated files.
- Add tests for behavior changes.
- Do not commit automatically.

Before implementation, always identify:

1. Existing service to extend.
2. Existing tests to update.
3. Risk of response contract breakage.
4. Smallest safe implementation.