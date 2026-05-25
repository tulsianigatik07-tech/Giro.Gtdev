# Giro.gtdev — AI Engineering Intelligence Platform

## 1. Overview

Giro.gtdev = AI-powered engineering co-pilot for understanding codebases. Developer connects a GitHub repo. Giro indexes it, builds semantic understanding, and answers questions about architecture, code structure, and behavior. V1 is read-only — Giro explains, retrieves, and reasons about code, but does not modify it.

Built for a single developer or small team that wants to onboard faster onto a codebase, debug across files, or get architectural answers without hunting through 50 source files manually.

---

## 2. Tech Stack

* Node.js + TypeScript (Backend API + workers)
* Next.js 15 (Frontend + API routes for auth)
* PostgreSQL with pgvector (Database + vector search via Supabase/Neon)
* Prisma (ORM)
* Redis (Cache + BullMQ background queue)
* Anthropic Claude (LLM for Q&A + reasoning)
* OpenAI text-embedding-3-small (Embeddings — cheap, 1536-dim)
* tree-sitter (AST parsing for code chunking)
* Octokit (GitHub API client)
* GitHub OAuth (Authentication)
* Tailwind + shadcn/ui (Frontend styling)
* Sentry (Error monitoring)
* SSE / EventSource (Streaming Q&A responses)

---

## 3. Architecture / Organization

* Single-tenant solo dev product. One user, multiple repos.
* Three deployable components:
  * `web` — Next.js frontend + auth + thin API
  * `api` — Node.js backend (REST + SSE)
  * `worker` — BullMQ background jobs (indexing, embedding)
* All three share the same Postgres + Redis.
* No Kubernetes. Deploy on Railway / Fly.io / Render.
* Docker Compose for local dev.
* Single role in V1: Developer.
* GitHub is the source of truth for code. Giro indexes a snapshot per branch.

---

## 4. User Roles

### Developer (only role in V1)
* Connect GitHub account via OAuth
* Connect one or more repos
* Trigger indexing
* Ask questions about repo
* Run semantic + keyword search
* Browse architecture overview
* View session history
* Execute read-only tools (read file, grep, list dir)
* Manage repo settings (re-index, disconnect)

### Admin (V2+)
* Not in V1. Single-user product.

---

## 5. V1 Scope

### INCLUDED

#### Auth & Account
* GitHub OAuth signup / login
* JWT session
* Account dashboard
* Disconnect GitHub

#### Repository Management
* Connect a GitHub repo (private or public)
* List connected repos
* Trigger re-index
* View index status (PENDING / RUNNING / COMPLETED / FAILED)
* Disconnect repo (purges chunks, embeddings, sessions)
* Default branch indexing only in V1

#### Indexing Pipeline
* Clone repo (shallow, default branch)
* Walk filesystem, filter by include/exclude rules
* Parse files with tree-sitter (JS/TS/Python/Go in V1)
* AST-aware chunking by function, class, module
* Generate embeddings (OpenAI batch API)
* Build symbol table (functions, classes, exports, imports)
* Compute import graph
* Write chunks + symbols + embeddings to Postgres
* Webhook receiver for push events → incremental re-index

#### Semantic Search
* Hybrid search (vector + keyword via pg_trgm + tsvector)
* Top-K with re-ranking
* Filter by file path, language, entity type
* Returns ranked chunks with snippets

#### AI Q&A
* Ask question scoped to a repo
* Backend runs retrieval pipeline
* Assembles context within token budget
* Streams Claude response via SSE
* Cites source files + line numbers
* Stores question + answer in session

#### Architecture Understanding
* Auto-generated repo summary on first index
* Module / folder overview
* Detected entry points (server.js, main.py, index.ts)
* Key dependencies (from package.json / requirements.txt / go.mod)
* Top symbols by import count
* Tech stack inference

#### Session Persistence
* Sessions scoped to (user, repo) pair
* Each session has a list of turns (user / agent / tool_call / tool_result)
* Sessions persist across browser reloads
* List all past sessions per repo
* Resume a session from the dashboard
* Auto-title sessions from first user question

#### Read-Only Tool Execution
* `read_file(path, start_line?, end_line?)` — read content from indexed snapshot
* `grep_search(query, path_pattern?)` — regex search
* `list_directory(path)` — list files in a folder
* `find_symbol(name)` — locate a function/class by name
* `get_file_tree()` — return repo structure
* All tools logged to ToolCall audit table
* Tool calls executed by the backend, not in a sandbox (no shell access in V1)

#### Dashboard
* List of connected repos with index status
* Last activity per repo
* Click repo → repo workspace (chat + search + browse)
* Account / settings page

### NOT INCLUDED (V2+)
* Code modification (writes, commits, PRs)
* Multi-agent swarms / sub-agent spawning
* Bash / shell execution
* Multi-branch indexing
* Multi-tenant / team support
* Kubernetes / multi-region infra
* Distributed graph store (Neo4j)
* Vector DB beyond pgvector
* Enterprise policy engine
* Cross-repo retrieval
* IDE plugin / VS Code extension
* Custom embedding models / self-hosted LLMs
* Knowledge graph visualization
* Approval workflows
* Replay / time-travel debugging
* Branching sessions
* Public sharing of sessions
* Slack / Discord bot

---

## 6. Core Product Rules

* One developer account = one GitHub identity
* User must connect GitHub before doing anything else
* A repo must finish indexing before Q&A or search work
* Q&A always scoped to a single repo (no cross-repo in V1)
* Every Q&A answer must cite at least one source chunk OR explicitly say "not found in repo"
* Read-only: Giro never writes to user's GitHub
* Every tool call recorded in ToolCall table
* Indexing failures must surface to UI with clear error
* Re-indexing replaces old chunks, never appends duplicates
* Sessions never auto-delete in V1 (user must explicitly delete)
* Max repo size for V1: 500 MB / 100k files (reject larger ones with clear message)
* Max indexed file size: 1 MB (skip larger files, log skip reason)
* Files in `.gitignore` are never indexed
* Lockfiles, minified JS, vendor dirs auto-excluded
* No code execution of indexed code

---

## 7. Main Features

### Repo Connection
* GitHub OAuth grants Giro `repo` scope (read-only)
* User picks a repo from their accessible repos
* Giro registers webhook for push events
* Initial index triggered automatically

### Indexing
* Clone repo into ephemeral worker filesystem
* Walk + parse + chunk + embed
* Progress stream to UI: files parsed, chunks created, embeddings generated
* On completion: clean up cloned repo, mark status COMPLETED
* On failure: keep error log, mark FAILED, allow retry

### Architecture Overview
* Generated once on first successful index
* Includes:
  * Tech stack (languages + frameworks detected)
  * Entry points
  * Module summary (per top-level folder)
  * Key files (most-imported)
  * Dependency summary
* Stored as `RepositorySummary`
* Re-generated on full re-index

### Semantic Search
* Search bar in repo workspace
* Returns ranked chunks
* Each result shows: file path, snippet, entity name, relevance score
* Click result → opens file viewer at that location

### AI Q&A
* Chat-style interface
* User types question
* Backend runs retrieval, assembles context, streams Claude response
* Source citations rendered as clickable file references
* Follow-up questions reuse session context
* User can pin a file to always include it in context
* User can rerun a question with different files pinned

### File Viewer
* Read-only code viewer with syntax highlighting
* Opens at specific line range when clicked from a citation or search result
* Shows file structure (functions/classes) in a side panel
* No editing in V1

### Session Management
* Auto-create session on first message in a repo
* Auto-title from first question (LLM-generated)
* Sidebar lists all sessions per repo, sorted by last activity
* Click session to resume
* Delete session button (soft delete, keeps audit trail)

---

## 8. Retrieval / Memory Rules

### Chunking Rules
* Use tree-sitter AST per supported language
* One chunk per function, class, or top-level export
* Module-level chunk = file summary + signature list
* Markdown / config files chunked by section / top-level keys
* Each chunk has: file_path, start_line, end_line, entity_name, entity_type, language, content, embedding, token_count

### Embedding Rules
* Model: `text-embedding-3-small` (1536-dim)
* Embed: signature + docstring + body, capped at 8000 tokens per chunk
* Batch API: max 100 chunks per call
* Embeddings stored in pgvector column with HNSW index
* Re-embed only on chunk content change (signature hash)

### Retrieval Pipeline (per Q&A turn)
1. Parse user query → extract entities (file names, function names)
2. Run hybrid search:
   * Vector: top 30 by cosine similarity
   * Keyword: pg_trgm fuzzy + tsvector full-text
   * Symbol exact-match: if query mentions a known symbol name
3. Fuse + re-rank with weighted score:
   * `0.5 × vector_score + 0.2 × keyword_score + 0.2 × recency_decay + 0.1 × import_centrality`
4. Apply diversity: max 3 chunks per file
5. Apply token budget: greedy fit to context window
6. Always include pinned files in full
7. Always include architecture overview (compressed)
8. Final assembly: pinned files → architecture overview → ranked chunks → conversation history

### Context Budget
| Section | Token Budget |
|---|---|
| System prompt + tools | 4,000 |
| Architecture overview (compressed) | 2,000 |
| Pinned files (full) | up to 30,000 |
| Retrieved chunks | up to 40,000 |
| Conversation history (last 5 turns full) | 10,000 |
| Older turns (summarized) | 2,000 |
| Reserved for response | 8,000 |
| **Total target** | **~96,000** (Claude Sonnet 200k window, leaves headroom) |

### Conversation Compression
* Last 5 turns kept verbatim
* Turns 6-15 compressed to 1-2 sentence summaries (Haiku model, async)
* Turns beyond 15 dropped from context but retained in DB
* Summaries are computed after a turn completes, not blocking next turn

### Re-Indexing Rules
* Webhook on push → diff-based incremental re-index
* For each changed file: re-parse, diff chunks by content hash, re-embed only changed chunks
* Full re-index only on user request or schema migration
* During re-index, search/Q&A continue working against last successful index

---

## 9. Safety Rules

### Read-Only Boundary
* No file writes
* No bash / shell execution
* No git operations after initial clone
* No HTTP requests to user-defined URLs
* No code execution of indexed code

### Secret Handling
* Files matching `.env*`, `*.pem`, `id_rsa`, `credentials*` skipped during indexing
* If a chunk contains a high-entropy string matching a secret pattern (AWS key, JWT, generic API key regex), redact before storing
* OAuth tokens encrypted at rest using application-level AES-256
* GitHub tokens never logged
* Chat outputs scanned for secret patterns before persisting

### PII / Privacy
* User code stays in user's database row (RLS or application-enforced filter)
* Logs redact paths containing `secrets/`, `private/`
* Indexed content never sent to third parties except OpenAI (embeddings) and Anthropic (Q&A)
* User can delete a repo to purge all chunks, sessions, embeddings within 5 minutes

### Rate Limiting
| Endpoint | Limit |
|---|---|
| `POST /qa/ask` | 30/hour per user |
| `POST /search` | 100/hour per user |
| `POST /repos/:id/reindex` | 5/day per repo |
| `GET /tools/*` (per session) | 200/session |
| Generic API | 1000/hour per user |

### Tool Execution Safety
* All tool calls validated against JSON schema before execution
* Path inputs normalized; reject any path containing `..` or absolute paths
* Tool results truncated at 50 KB
* Tool calls logged to ToolCall table with status, duration, params hash
* Tool results scanned for secrets before returning to LLM

### Failure Handling
* Indexing failures retried with exponential backoff (3 attempts)
* LLM failures (rate limit, timeout) retried once, then surfaced to user
* Embedding failures fall back to keyword-only search for affected chunks
* Webhook delivery failures: GitHub retries 3x, we queue manual re-index option

---

## 10. Database Models

### User
* id
* email
* name
* avatarUrl
* githubId
* githubUsername
* githubAccessToken (encrypted)
* createdAt
* updatedAt

### Repository
* id
* userId
* githubRepoId
* owner
* name (e.g. `vercel/next.js`)
* defaultBranch
* visibility (PUBLIC / PRIVATE)
* status (CONNECTED / INDEXING / READY / FAILED / DISCONNECTED)
* lastIndexedSha
* lastIndexedAt
* webhookId (nullable)
* webhookSecret (encrypted)
* createdAt
* updatedAt

### IndexJob
* id
* repositoryId
* type (FULL / INCREMENTAL)
* status (PENDING / RUNNING / COMPLETED / FAILED)
* triggeredBy (USER / WEBHOOK / SYSTEM)
* commitSha (nullable)
* filesProcessed
* chunksCreated
* embeddingsGenerated
* errorMessage (nullable)
* startedAt
* completedAt (nullable)
* createdAt

### CodeChunk
* id
* repositoryId
* filePath
* language
* entityType (FUNCTION / CLASS / METHOD / MODULE / SECTION / OTHER)
* entityName (nullable)
* startLine
* endLine
* content (text)
* contentHash (sha256, for dedup)
* tokenCount
* embedding (vector(1536))
* embeddingModel (e.g. `text-embedding-3-small`)
* lastIndexedSha
* createdAt
* updatedAt

### CodeSymbol
* id
* repositoryId
* name (e.g. `createBooking`)
* kind (FUNCTION / CLASS / METHOD / VARIABLE / EXPORT / IMPORT)
* filePath
* startLine
* endLine
* signature (nullable)
* docstring (nullable)
* importedFrom (nullable, for imports)
* createdAt

### RepositorySummary
* id
* repositoryId (unique)
* techStack (json)
* entryPoints (json)
* moduleOverview (json)
* keyFiles (json)
* dependencies (json)
* generatedAt
* generatedFromSha

### Session
* id
* userId
* repositoryId
* title
* status (ACTIVE / ARCHIVED / DELETED)
* lastActiveAt
* turnCount
* createdAt
* updatedAt

### Message
* id
* sessionId
* role (USER / ASSISTANT / TOOL_CALL / TOOL_RESULT / SYSTEM)
* content (text)
* tokenCount
* toolName (nullable)
* toolParams (json, nullable)
* toolStatus (SUCCESS / ERROR, nullable)
* sequenceNumber
* citations (json, list of {filePath, startLine, endLine})
* createdAt

### ToolCall
* id
* sessionId
* messageId
* toolName
* params (json)
* result (text, truncated)
* status (SUCCESS / ERROR / DENIED)
* errorMessage (nullable)
* durationMs
* createdAt

### PinnedFile
* id
* sessionId
* filePath
* createdAt

### Enums

Role:
- DEVELOPER

RepoStatus:
- CONNECTED
- INDEXING
- READY
- FAILED
- DISCONNECTED

IndexJobType:
- FULL
- INCREMENTAL

IndexJobStatus:
- PENDING
- RUNNING
- COMPLETED
- FAILED

EntityType:
- FUNCTION
- CLASS
- METHOD
- MODULE
- SECTION
- OTHER

SymbolKind:
- FUNCTION
- CLASS
- METHOD
- VARIABLE
- EXPORT
- IMPORT

MessageRole:
- USER
- ASSISTANT
- TOOL_CALL
- TOOL_RESULT
- SYSTEM

ToolStatus:
- SUCCESS
- ERROR
- DENIED

SessionStatus:
- ACTIVE
- ARCHIVED
- DELETED

---

## 11. API Contract

### Auth
* GET /auth/github (OAuth start)
* GET /auth/github/callback
* POST /auth/logout
* GET /auth/me

### Repositories
* GET /repos (list connected repos)
* GET /repos/available (GitHub repos user can connect)
* POST /repos/connect (body: githubRepoId)
* DELETE /repos/:id (disconnect + purge)
* GET /repos/:id
* GET /repos/:id/summary
* POST /repos/:id/reindex (triggers full re-index)
* GET /repos/:id/index-jobs (list past index jobs)
* GET /repos/:id/index-jobs/:jobId

### Webhooks
* POST /webhooks/github (push events)

### Search
* POST /repos/:id/search (body: query, filters)

### Q&A / Chat
* POST /sessions (body: repositoryId)
* GET /sessions (query: repositoryId)
* GET /sessions/:id
* DELETE /sessions/:id
* GET /sessions/:id/messages
* POST /sessions/:id/ask (body: question, returns SSE stream)
* POST /sessions/:id/pin (body: filePath)
* DELETE /sessions/:id/pin/:filePath

### Tools (called by backend during Q&A; also exposed for direct use)
* POST /repos/:id/tools/read-file
* POST /repos/:id/tools/grep
* POST /repos/:id/tools/list-directory
* POST /repos/:id/tools/find-symbol
* GET /repos/:id/tools/file-tree

### Files (read-only viewer)
* GET /repos/:id/files/:path (returns file content from indexed snapshot)
* GET /repos/:id/files/:path/symbols (returns symbols in this file)

### Account
* GET /account
* DELETE /account (purges everything)

---

## 12. User Flows

### Connect Repo
1. User clicks "Connect GitHub"
2. Redirected to GitHub OAuth
3. Returns to Giro with token
4. User sees list of accessible repos
5. User picks a repo
6. Backend creates Repository row (status CONNECTED)
7. Backend registers GitHub webhook
8. Backend enqueues full IndexJob
9. UI navigates to repo page showing indexing progress

### Indexing
1. Worker picks up IndexJob
2. Status → RUNNING
3. Shallow clone repo
4. Walk files, apply include/exclude filters
5. For each file:
   * Skip if size > 1 MB or matches secret pattern
   * Parse with tree-sitter
   * Generate chunks
6. Batch chunks to OpenAI embeddings API
7. Batch insert chunks + embeddings into Postgres
8. Build symbol table
9. Generate RepositorySummary using Claude
10. Status → COMPLETED, repo status → READY
11. Cleanup cloned repo

### Ask a Question
1. User opens repo workspace, types question
2. If no active session, create one
3. POST /sessions/:id/ask streams SSE
4. Backend:
   * Saves user message
   * Runs retrieval pipeline
   * Assembles context
   * Calls Claude with streaming
5. As tokens stream in:
   * Stream forwarded to client via SSE
   * Client renders typing effect
6. If LLM emits tool calls:
   * Backend executes tools, streams results back as SSE events
   * LLM receives results, continues
7. On stream end:
   * Save assistant message with citations
   * Return final message ID

### Semantic Search
1. User types in search bar
2. Frontend POSTs to /repos/:id/search
3. Backend runs hybrid search
4. Returns ranked results
5. User clicks a result → opens file viewer at line range

### Re-index After Push
1. GitHub sends push webhook
2. Backend verifies HMAC signature
3. Backend creates INCREMENTAL IndexJob
4. Worker:
   * Fetches diff between last indexed SHA and new SHA
   * For each changed file: re-parse, re-chunk, re-embed
   * Updates lastIndexedSha
5. UI shows fresh data on next query

### Disconnect Repo
1. User clicks "Disconnect"
2. Confirmation modal
3. Backend:
   * Deletes GitHub webhook
   * Soft-deletes Repository (status DISCONNECTED)
   * Background job purges chunks, embeddings, sessions, summary within 5 min
   * GitHub access for that repo retained at GitHub side until user revokes app

### Delete Account
1. User clicks "Delete account" in settings
2. Re-confirmation
3. Backend:
   * Revokes GitHub OAuth
   * Deletes all repos, chunks, sessions, messages, embeddings
   * Deletes user row
   * Returns to landing page

---

## 13. Backend Architecture

