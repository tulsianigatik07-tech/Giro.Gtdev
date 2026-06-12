# Giro.gtdev — Tasks

# PHASE 1 — Repository Intelligence Core ✅ COMPLETE

## Core Backend
- [x] Setup backend architecture
- [x] Setup routing structure
- [x] Setup middleware system
- [x] Setup deterministic service layer
- [x] Setup validation pipeline
- [x] Setup logging and error handling

## Repository Lifecycle
- [x] Repository connection API
- [x] Repository ingestion flow
- [x] Repository metadata extraction
- [x] Repository indexing lifecycle
- [x] Indexed repository detection
- [x] Repository stale-state handling

## Retrieval Engine
- [x] Semantic retrieval pipeline
- [x] Keyword retrieval pipeline
- [x] Hybrid retrieval engine
- [x] File-level retrieval explanations
- [x] Dependency graph retrieval
- [x] Symbol-aware retrieval
- [x] Deterministic retrieval ordering

## Context Engine
- [x] Context assembly pipeline
- [x] Deterministic context synthesis
- [x] Context ranking system
- [x] Context budget limiting
- [x] Selected context persistence
- [x] Stable retrieval orchestration

## Session Architecture
- [x] Session engine
- [x] Repository-aware sessions
- [x] Ask orchestration flow
- [x] Message persistence
- [x] Citation generation
- [x] Deterministic answer synthesis

---

# PHASE 2 — Retrieval Quality Optimization 🚧 MOSTLY COMPLETE

## Retrieval Ranking
- [x] Weighted hybrid reranking
- [x] Semantic/keyword balancing
- [x] Duplicate chunk suppression
- [x] Cross-file relevance boosting
- [ ] Symbol score calibration
- [ ] Graph traversal weighting

## Context Quality
- [x] Retrieval diversity enforcement
- [x] Retrieval blind spot detection
- [x] Retrieval explainability metadata
- [ ] Adjacent chunk stitching
- [ ] Smarter chunk merging
- [ ] Context compression improvements
- [ ] Long-file handling
- [ ] Retrieval fallback heuristics

## Answer Quality
- [x] Retrieval trace metadata
- [x] Confidence scoring
- [x] Retrieval quality scoring
- [x] Explanation consistency checks
- [ ] Architecture-aware explanations
- [ ] Entrypoint tracing
- [ ] Repository structure summaries

---

# PHASE 3 — Repository Indexing Scalability 🚧 ACTIVE

## Incremental Indexing
- [x] Repository index lifecycle metadata
- [x] File snapshot storage
- [x] Changed-file detection
- [x] Incremental indexing plan builder
- [x] Incremental indexing execution engine
- [x] Incremental deletion cleanup foundation
- [x] Symbol index store
- [x] Symbol extraction pipeline
- [ ] Persist extracted symbols during indexing
- [ ] Incremental symbol refresh for changed files
- [ ] Removed-file symbol pruning
- [ ] Incremental graph update foundation

## Indexing Pipeline
- [x] Changed-file indexing foundation
- [x] Incremental indexing foundation
- [ ] Parallel indexing workers
- [ ] Batched indexing jobs
- [ ] Retry-safe indexing
- [ ] Reindex scheduler

## Performance
- [ ] Retrieval latency benchmarks
- [ ] Context assembly benchmarks
- [ ] Graph traversal benchmarks
- [ ] Token estimation optimization
- [ ] Large repository stress tests
- [ ] Memory optimization

## Lifecycle Management
- [ ] Automatic stale detection
- [ ] Repository cleanup
- [ ] Session cleanup lifecycle
- [ ] Cache invalidation rules
- [ ] Background maintenance jobs

---

# PHASE 4 — Persistence & Infrastructure

## Persistence
- [ ] Persistent session storage
- [ ] Persistent retrieval history
- [ ] Persistent indexed chunks
- [ ] Persistent symbols
- [ ] Persistent citations
- [ ] Persistent repository metadata

## Infrastructure
- [ ] PostgreSQL integration
- [ ] pgvector integration
- [ ] Redis caching
- [ ] Queue-based indexing
- [ ] Background workers
- [ ] Structured observability

---

# PHASE 5 — API Stabilization

## Contracts
- [x] Stable repository metadata contracts
- [x] Indexed repository contract coverage
- [x] Route ownership contract coverage
- [ ] Shared DTO validation
- [ ] Error normalization
- [ ] Versioned APIs
- [ ] Pagination standards
- [ ] Request tracing IDs

## Security
- [x] Repository ownership validation
- [x] Session repository ownership checks
- [x] Repository isolation tests
- [ ] Input sanitization
- [ ] Rate limiting
- [ ] Abuse protection
- [ ] Secure repository path handling

---

# PHASE 6 — Testing & Reliability

## Automated Testing
- [x] Retrieval engine tests
- [x] Determinism tests
- [x] Context assembly tests
- [x] Indexing lifecycle tests
- [x] Repository contract tests
- [x] Route ownership tests
- [ ] Full route integration tests
- [ ] Failure recovery tests

## Reliability
- [x] Empty input handling
- [x] Missing metadata resilience
- [x] Deterministic snapshot isolation
- [ ] Empty repository handling
- [ ] Large repository handling
- [ ] Corrupted chunk recovery
- [ ] Missing symbol resilience
- [ ] Graceful degraded retrieval
- [ ] Stable retry behavior

---

# PHASE 7 — Frontend Platform

## Frontend
- [ ] Dashboard UI
- [ ] Repository upload UI
- [ ] Retrieval inspection UI
- [ ] Session history UI
- [ ] Architecture visualization
- [ ] Graph visualization UI

## Realtime
- [ ] Streaming responses
- [ ] SSE/WebSocket support
- [ ] Live retrieval progress
- [ ] Indexing progress streaming

---

# PHASE 8 — OSS Readiness

## Documentation
- [ ] Architecture documentation
- [ ] Setup guide
- [ ] API documentation
- [ ] Local development guide
- [ ] Benchmark documentation
- [ ] Repository diagrams

## Open Source Readiness
- [ ] Issue templates
- [ ] PR templates
- [ ] Contribution guidelines
- [ ] Example repositories
- [ ] Demo screenshots
- [ ] Public launch preparation

---

# CURRENT STATUS

Current backend capabilities include:

- deterministic retrieval orchestration
- hybrid repository intelligence
- dependency graph analysis
- symbol-aware retrieval
- deterministic answer synthesis
- context budget enforcement
- indexing lifecycle metadata
- changed-file detection
- file snapshot persistence
- incremental indexing planning
- incremental indexing execution
- deletion cleanup foundation
- symbol index store
- repository symbol extraction engine
- repository-aware session architecture
- ownership and isolation protections
- 385+ passing backend tests

Backend maturity has progressed beyond prototype stage into scalable MVP infrastructure.

Current priority:

1. Persist extracted symbols during indexing
2. Incremental symbol refresh for changed files
3. Removed-file symbol pruning
4. Incremental graph update foundation
5. Retry-safe indexing
6. Automatic stale detection
7. Repository/session cleanup lifecycle