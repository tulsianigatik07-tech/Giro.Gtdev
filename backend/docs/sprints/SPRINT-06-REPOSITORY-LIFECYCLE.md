# Sprint 06 — Repository Lifecycle Completion

## Goal

Complete the repository lifecycle from connection to cleanup.

Giro should support a clear repository lifecycle:

Connect
→ Index
→ Refresh
→ Detect Changes
→ Reindex
→ Mark Stale
→ Cleanup
→ Reconnect

## Why This Sprint Matters

Repository cleanup is required before Giro can become production-ready.

Without cleanup:

- repository metadata can become stale
- symbols can remain after repo deletion
- intelligence history can outlive repositories
- dashboards may show dead repositories
- future persistence will become messy

This sprint completes the lifecycle foundation before moving into background jobs, persistence, and frontend work.

## Current Status

- [x] Repository cleanup planner
- [x] Repository cleanup executor
- [ ] Repository cleanup report
- [ ] Repository cleanup route
- [ ] Repository cleanup route tests
- [ ] Repository cleanup integration test
- [ ] Repository cleanup documentation

## Commit Plan

### 1. Cleanup Planner

Status: Done

Commit:

`feat: add deterministic repository cleanup planner`

Purpose:

Build a side-effect-free cleanup plan.

### 2. Cleanup Executor

Status: Done

Commit:

`feat: implement deterministic repository cleanup executor`

Purpose:

Execute supported cleanup operations from the cleanup plan.

### 3. Cleanup Report

Status: Next

Commit:

`feat: add repository cleanup report`

Purpose:

Convert executor results into a frontend/API-friendly report.

Expected output:

- repository id
- success boolean
- executed resources
- skipped resources
- warnings
- summary counts

### 4. Cleanup Route

Status: Pending

Commit:

`feat: add repository cleanup route`

Purpose:

Expose authenticated cleanup route.

Expected route:

`DELETE /repos/:owner/:repo`

Rules:

- require authentication
- enforce ownership
- build cleanup plan
- execute cleanup
- return cleanup report

### 5. Cleanup Route Tests

Status: Pending

Commit:

`test: add repository cleanup route coverage`

Tests:

- unauthenticated request returns 401
- non-owner returns 403
- missing repo returns 404/current existing pattern
- owner can cleanup repository
- cleanup removes supported metadata

### 6. Cleanup Integration Test

Status: Pending

Commit:

`test: add repository cleanup integration coverage`

Flow:

Connect/index metadata
→ assign owner
→ build dashboard
→ cleanup
→ verify metadata removed
→ verify dashboard missing/empty state

### 7. Sprint Documentation

Status: Pending

Commit:

`docs: document repository lifecycle cleanup`

Purpose:

Document lifecycle behavior and cleanup boundaries.

## Non-Goals

This sprint will NOT:

- delete cloned repository files from disk
- introduce database persistence
- introduce background jobs
- delete remote GitHub repositories
- perform async cleanup
- add frontend UI

## Acceptance Criteria

Sprint is complete when:

- cleanup planner exists
- cleanup executor exists
- cleanup report exists
- cleanup API route exists
- ownership is enforced
- tests cover core cleanup behavior
- TypeScript passes
- full Vitest suite passes

## Future Work After Sprint

After this sprint:

1. Parallel indexing workers
2. Batched indexing jobs
3. Reindex scheduler
4. PostgreSQL persistence
5. pgvector integration
6. Frontend dashboard