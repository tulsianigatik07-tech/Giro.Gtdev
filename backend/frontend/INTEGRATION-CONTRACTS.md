# Frontend–backend integration contracts

Audited against the backend source on 2026-07-17. Protected routes require
`Authorization: Bearer <token>`. Repository and session ownership is checked
after authentication; a missing owned resource returns `404`, while a known
resource owned by another user returns `403`.

## Contract matrix

| Capability | Method and route | Input | Success response | Optional / nullable | Status and stable errors | Access |
| --- | --- | --- | --- | --- | --- | --- |
| Authentication token | Every protected request | Bearer header only; never query/body | Route-specific standard envelope | JWT email may be absent internally | `401 unauthorized` for missing header; `401 invalid_token` for invalid token | Authentication required |
| Repository connection | `POST /repos/connect` | JSON `{ repoUrl, cloneOptions?: { branch? } }` | `200 { success:true, data:{ repositoryId, jobId, status:"queued" }, requestId }` | `cloneOptions`, branch optional | `400 validation_failed`, `400 invalid_repo_url`, `401 unauthorized`, `403 repo_not_owned`, `429 rate_limit_exceeded`, `504 request_timeout`; clone/index failures are asynchronous job/SSE failures | Auth + existing ownership if already known |
| Repository listing | `GET /repos/indexed` | None | `200 data:{ repositories, count }` | Repository timestamps, failure fields, and index mode may be `null` | `401 unauthorized` | Auth; response filtered to owner |
| Repository summary | `GET /repositories/:repositoryId/summary` | `repositoryId = encodeURIComponent("owner/repo")` | `200 data:{ summary }` | Summary arrays may be absent in older payloads; item `path`, `kind`, `reason` optional | `400 validation_failed`, `401 unauthorized`, `403 repo_not_owned`, `404 repo_not_connected`, `500 internal_error` | Auth + repository owner |
| Indexing job status | `GET /indexing/jobs/:jobId` | Encoded job ID | `200 data:{ jobId, repositoryId, status, progress, currentStage, attempt, maxAttempts, failure }` | `failure` is `null` or `{ code,message,retryable }` | `400 validation_failed`, `401 unauthorized`, `403 repo_not_owned`, `404 indexing_job_not_found`, `500 internal_error` | Auth + repository owner |
| Indexing SSE | `GET /repositories/:repositoryId/indexing/events` | Encoded repository ID; bearer header; `Accept:text/event-stream` | Named `progress`, `completed`, `failed`, `heartbeat` events; JSON data `{ jobId,repositoryId,stage,percentage,message,timestamp }` | No nullable fields | `400 validation_failed`, `401 unauthorized`, `403 repo_not_owned`, `404 indexing_job_not_found`, `429 rate_limit_exceeded`, `500 internal_error` | Auth + repository owner |
| Session creation | `POST /sessions` | JSON `{ owner, repo, title? }` | `201 data:Session` | `title` optional (server default); messages/context initially empty | `400 validation_failed`, `401 unauthorized`, `403 repo_not_owned`, `404 repo_not_connected`, `500 session_error` | Auth + repository owner |
| Session listing | `GET /sessions` | None | `200 data:{ sessions:SessionSummary[], count }`; summary contains `messageCount`, not `messages` | None | `401 unauthorized`, `500 session_error` | Auth; response filtered to session owner |
| Session detail | `GET /sessions/:id` | Encoded session ID | `200 data:Session` | Selected-context provenance fields and message confidence are not persisted; citations may be legacy | `401 unauthorized`, `403 session_not_owned`, `404 session_not_found`, `500 session_error` | Auth + session owner |
| Session deletion | `DELETE /sessions/:id` | Encoded session ID | `200 data:{ id, deleted:true }` | None | `401 unauthorized`, `403 session_not_owned`, `404 session_not_found`, `500 session_error` | Auth + session owner |
| Session ask | `POST /sessions/:id/ask` | JSON `{ question }` (1–2000 chars) | `200 data:{ answer,sources,citations,metadata }` | Public `metadata.confidence` is optional for compatibility | `400 validation_failed`, `401 unauthorized`, `403 session_not_owned` / `repo_not_owned`, `404 session_not_found` / `repo_not_connected`, `429 rate_limit_exceeded`, `503 dependency_unavailable`, `504 request_timeout`, `500 ask_error` | Auth + session owner + repository owner |
| Citations | Nested in ask and assistant messages | None | Stable backend order; `{ repositoryId,relativeFilePath,language,chunkId,startLine,endLine,retrievalType,score,symbol?,repositoryVersion }` | `symbol` optional; historical legacy citations use `filePath/startLine/endLine/snippet` | Parent route status | Parent route ownership |
| Confidence | `data.metadata.confidence` from session ask | None | Public `{ level:"high"|"medium"|"low"|"insufficient", score, answerable, reasons }` | Entire confidence object optional for historical compatibility | Low/insufficient are successful responses, not API errors | Parent route ownership |
| Retrieval inspector | `POST /retrieval/hybrid` | JSON `{ query, owner, repo, limit? }` (`limit <= 50`) | `200 data:{ query,repository,results,citations?,stats }` | `limit`, citations, chunk ID, symbol, individual signals optional | `400 validation_failed`, `401 unauthorized`, `403 repo_not_owned`, `404 repo_not_connected`, `429 rate_limit_exceeded`, `503 dependency_unavailable`, `504 request_timeout`, `500 retrieval_error` | Auth + repository owner |
| Standard error envelope | All vertical-slice routes | N/A | `{ success:false, error:{ code,message,details?,retryable?,status?,category? }, requestId }` | Extended error fields optional on older handlers | HTTP status remains authoritative; validation is normally `400`, thrown Zod validation can be `422` | Same as parent route |

## Verified integration decisions

- The backend API default is `http://localhost:8000`. The frontend uses only
  `NEXT_PUBLIC_GIRO_API_URL`, normalizes trailing slashes, and rejects malformed
  absolute URLs.
- A healthy already-indexed repository is detected through the authenticated
  repository list and opens its overview. Otherwise the real connect endpoint
  creates an indexing job. The backend does not currently return a `409`
  already-connected result or a separate repository-allowlist error code.
- The overview combines the owned repository-list DTO (status and counts) with
  the encoded repository-summary DTO. It does not call the legacy split
  `/:owner/:repo/dashboard` route.
- Ask uses only `POST /sessions/:id/ask`. The UI is progressive but does not
  represent the deterministic response as token streaming.
- Retrieval inspection renders public hybrid result signals and stats only.
  Stitching and expansion are explicitly marked as not exposed; source content,
  cache state, graph-expansion traces, and internal ranking diagnostics are not
  rendered.

## Manual local verification

1. In `backend/`, copy/configure `.env`, then run `pnpm dev`; confirm the API is
   listening on port `8000` (or set the matching frontend URL if `PORT` differs).
2. In `backend/frontend/`, set
   `NEXT_PUBLIC_GIRO_API_URL=http://localhost:8000` in `.env.local` and run
   `pnpm dev` (Next.js defaults to port `3000`).
3. Open `/login`, enter a valid bearer token, and confirm `/dashboard` loads.
4. Connect a public `https://github.com/owner/repo` URL once; confirm navigation
   to its indexing page. Submitting an already healthy owned repository should
   instead open its overview.
5. In a separate `backend/` terminal run `pnpm indexing:work-once` after the job
   is queued; watch real SSE progress and its connection/reconnect indicator.
6. Confirm only a terminal `completed` event redirects to the repository page.
   For a terminal failure, confirm the real failure message and retry action.
7. On the repository page, verify identity, status/counts, summary sections, and
   repository version against the API response; absent sections should remain
   muted rather than populated with placeholder facts.
8. Create a session, ask one repository question once, and confirm the grounded
   answer appears after the non-streaming loading state.
9. Inspect the confidence level/score/reasons. Confirm low confidence is a
   warning and insufficient confidence preserves the backend fallback text.
10. Expand citations; verify relative path, language, line range, symbol when
    present, retrieval type, score, version, and copy-with-lines behavior. The
    GitHub action must remain disabled.
11. Open the retrieval inspector and compare public result order/signals/stats;
    confirm no source body or private diagnostics are displayed.
12. Refresh the chat page, reopen the session from the sidebar, and confirm
    historical messages render even without persisted confidence metadata.
13. Switch sessions, delete one, and confirm it disappears; deleting the active
    session should return to the dashboard.
14. Replace the stored token with an invalid token or enter one at login; confirm
    the token is cleared, `/login` is shown, and the intended destination is
    preserved in `next`.
15. For a failed request, expand technical details and confirm the backend
    request ID is present without exposing the bearer token.

This checklist does not claim a live database, provider, clone, or indexing run
was performed during the integration pass.
