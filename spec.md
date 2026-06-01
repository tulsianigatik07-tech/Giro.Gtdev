Giro.gtdev — Engineering Intelligence Platform

1. Problem Statement

Modern codebases are difficult to understand.

Developers spend significant time reconstructing architecture mentally:

* tracing imports across dozens of files
* understanding hidden dependencies
* searching for business logic manually
* rebuilding context after interruptions
* onboarding into unfamiliar repositories
* navigating fragmented engineering knowledge

Most existing AI coding tools focus heavily on:

* autocomplete
* inline generation
* code suggestions
* local file edits

But they struggle with:

* repository-level reasoning
* semantic architecture understanding
* durable engineering memory
* contextual retrieval quality
* scalable context orchestration

Giro.gtdev is designed to solve this problem.

The platform focuses on:

* repository intelligence
* semantic indexing
* architecture-aware retrieval
* contextual engineering reasoning
* conversational engineering memory
* grounded repository-aware AI responses

Rather than acting as a fully autonomous coding agent, Giro is designed as an engineering intelligence layer that helps developers understand systems faster.

⸻

2. Product Vision

Giro.gtdev is an AI-powered engineering intelligence platform.

A developer connects a GitHub repository.

Giro:

1. clones the repository
2. scans the filesystem
3. extracts repository intelligence
4. chunks and embeds semantic code context
5. stores vector memory
6. retrieves relevant engineering context
7. assembles optimized prompts
8. enables repository-aware AI conversations

The platform is optimized for:

* understanding large codebases
* onboarding faster
* debugging across files
* tracing architecture decisions
* semantic repository search
* contextual engineering conversations
* architectural reasoning

V1 intentionally prioritizes:

* retrieval quality
* repository understanding
* semantic memory
* grounded AI reasoning

before:

* autonomous code execution
* multi-agent orchestration
* code modification workflows

⸻

3. Current V1 Status

The current implementation already supports:

* repository ingestion
* repository scanning
* repository analysis
* semantic chunking
* vector embeddings
* pgvector storage
* semantic retrieval
* context orchestration
* AI-ready context assembly
* repository-aware AI chat
* streaming AI responses
* session memory infrastructure

Current backend architecture is functional and evolving iteratively.

⸻

4. V1 Product Focus

The V1 goal of Giro.gtdev is to build a repository intelligence system that can:

* index repositories reliably
* understand repository structure
* generate semantic repository memory
* retrieve relevant engineering context
* answer architectural questions accurately
* maintain conversational engineering memory
* explain relationships between files and symbols
* provide grounded repository-aware AI responses

The platform intentionally prioritizes:

* retrieval quality
* repository understanding
* engineering clarity
* semantic relevance
* context assembly quality

Over:

* autonomous repository modification
* shell execution
* enterprise orchestration
* generalized coding autonomy

⸻

5. Non-Goals (V1)

Giro.gtdev is NOT attempting to:

* replace IDEs
* autonomously modify repositories
* execute arbitrary shell commands
* become a generalized AGI coding agent
* support enterprise governance workflows
* optimize for massive organizations
* support multi-agent swarms
* provide production deployment automation
* perform autonomous pull request generation
* run arbitrary external tools

The focus remains:

* repository intelligence
* semantic retrieval
* engineering understanding
* architecture-aware reasoning
* contextual AI conversations

for individual developers and small engineering teams.

⸻

6. Engineering Principles

Retrieval Quality Over Infrastructure Complexity

Strong retrieval and context assembly matter more than distributed infrastructure.

Build Context Before Autonomy

Reliable repository understanding must exist before autonomous workflows.

Postgres First

Prefer PostgreSQL extensions before introducing specialized databases.

Read-Only By Default

The system should explain and retrieve before it modifies anything.

Async Everything Expensive

Indexing, embeddings, summarization, and compression should run asynchronously.

Fast Iteration Matters

Optimize for local development speed and engineering iteration.

Strong Observability From Day One

Every critical operation should be measurable and traceable.

Build the Smallest Intelligent System First

Do not overbuild autonomous behavior early.

Thin APIs, Smart Services

Routes should remain lightweight while business logic lives in modular services.

⸻

7. Tech Stack

Frontend

* Next.js 15
* React
* TypeScript
* TailwindCSS
* shadcn/ui

Backend

* Hono
* TypeScript
* SSE streaming
* Zod validation

Database

* PostgreSQL
* pgvector
* Prisma ORM

Queueing / Background Jobs

* Redis
* BullMQ

AI Layer

* Anthropic Claude (reasoning)
* OpenAI text-embedding-3-small
* GPT-4.1-mini (repository-aware chat)

Parsing / Repository Intelligence

* tree-sitter
* Octokit
* semantic chunking pipeline

Authentication

* GitHub OAuth
* JWT sessions

Observability

* Sentry
* OpenTelemetry
* structured JSON logs

Deployment

* Docker Compose
* Railway / Fly.io / Render
* Vercel (frontend)

⸻

8. High-Level System Architecture

Deployable Components

Web

Responsible for:

* authentication
* repository workspace
* streaming AI interface
* search UI
* architecture visualizations

API

Responsible for:

* repository ingestion
* retrieval orchestration
* semantic search
* context assembly
* AI streaming responses
* session management
* repository intelligence APIs

Worker

Responsible for:

* indexing
* embeddings
* incremental re-indexing
* summarization
* compression
* async retrieval optimization

⸻

9. Core Architecture Pipelines

Repository Intelligence Pipeline

graph TD
    GitHubRepo --> Clone
    Clone --> FileWalk
    FileWalk --> Analyzer
    Analyzer --> Chunking
    Chunking --> Embeddings
    Embeddings --> pgvector
    Chunking --> ContextAssembly

⸻

Semantic Retrieval Pipeline

graph TD
    Query --> SemanticSearch
    SemanticSearch --> Ranking
    Ranking --> Deduplication
    Deduplication --> Compression
    Compression --> ContextAssembly
    ContextAssembly --> AIModel

⸻

AI Chat Pipeline

graph TD
    UserQuery --> SessionMemory
    SessionMemory --> SemanticRetrieval
    SemanticRetrieval --> ContextAssembly
    ContextAssembly --> PromptBuilder
    PromptBuilder --> LLM
    LLM --> StreamedResponse

⸻

10. Core Features

Repository Connection

* GitHub repository connection
* repository sync management
* shallow cloning
* indexing triggers

Repository Intelligence

* framework detection
* language detection
* package manager detection
* monorepo detection
* entrypoint detection
* architecture overview generation

Semantic Chunking

* semantic file chunking
* line-aware chunk metadata
* token estimation
* chunk deduplication
* context compression

Vector Memory System

* OpenAI embeddings
* pgvector similarity search
* semantic retrieval
* ranked chunk retrieval
* contextual repository memory

AI Repository Chat

* repository-aware Q&A
* streaming responses
* contextual retrieval
* grounded engineering reasoning
* source citations

Session Memory

* persistent conversations
* repository-scoped sessions
* context windows
* conversational continuity

Read-Only Repository Tools

* read_file
* grep_search
* list_directory
* find_symbol
* get_file_tree

⸻

11. Repository Intelligence System

Repository Analysis

Generated after ingestion.

Includes:

* frameworks
* languages
* dependencies
* entrypoints
* folder structure
* module boundaries
* backend/frontend detection
* monorepo detection

Semantic Chunking

Chunking rules:

* code chunked by logical sections
* markdown chunked by headings
* config files chunked by top-level structures
* preserve line ranges
* preserve file metadata

Each chunk contains:

* file path
* line ranges
* language
* token estimate
* semantic content
* embedding vector

Semantic Embeddings

Model:

* text-embedding-3-small

Rules:

* batch processing
* incremental re-embedding
* chunk deduplication
* vector persistence

⸻

12. Retrieval System

Retrieval Pipeline

Per engineering query:

1. semantic search
2. reranking
3. deduplication
4. context compression
5. token budgeting
6. context assembly
7. AI prompt generation
8. streaming AI response

⸻

Retrieval Ranking

Weighted signals:

* vector similarity
* entrypoint importance
* architecture centrality
* config relevance
* conversational relevance

Penalized:

* generated files
* lockfiles
* minified assets
* duplicate chunks

⸻

Context Compression

Compression preserves:

* imports
* exported APIs
* function signatures
* class declarations
* architectural structure

Oversized context is trimmed intelligently.

⸻

Context Assembly

Assembly order:

1. pinned context
2. architecture overview
3. ranked semantic chunks
4. recent conversation history

⸻

13. AI Reasoning Layer

Prompt Assembly

Prompts are repository-aware.

The AI:

* answers ONLY from repository context
* avoids hallucinations
* cites files when possible
* behaves like a senior engineer
* refuses unsupported claims

⸻

Streaming Responses

Responses stream incrementally using SSE.

Includes:

* incremental text streaming
* metadata headers
* citation tracking
* token estimates

⸻

Repository-Aware Chat

Supports:

* architecture questions
* debugging discussions
* repository exploration
* implementation tracing
* dependency reasoning

⸻

14. Session & Memory System

Sessions

Sessions are scoped to:

* user
* repository

Each session stores:

* messages
* citations
* summaries
* context windows

⸻

Conversation Memory

Conversation memory supports:

* multi-turn reasoning
* conversational continuity
* context persistence
* engineering discussion history

Older messages may be summarized asynchronously.

⸻

Future Long-Term Memory

Future directions:

* engineering preferences
* repository evolution tracking
* architectural decision memory
* cross-session repository understanding

⸻

15. Read-Only Tooling

Current Tools

read_file

Read indexed file content.

grep_search

Regex search across indexed files.

list_directory

Return repository structure.

find_symbol

Locate functions/classes.

get_file_tree

Return repository hierarchy.

⸻

Tool Safety

* no shell execution
* no filesystem writes
* no arbitrary HTTP requests
* no git write operations

All tool calls remain fully auditable.

⸻

16. API Design

Repository APIs

* POST /repos/connect
* GET /repos/:id/summary
* POST /repos/:id/reindex

Retrieval APIs

* POST /search/context

Chat APIs

* POST /chat

Session APIs

* POST /sessions
* GET /sessions/:id
* GET /sessions/:id/messages

Context APIs

* POST /context/build

⸻

17. Database Models

Repository

Stores:

* repository metadata
* indexing status
* sync state

CodeChunk

Stores:

* semantic chunks
* embeddings
* line ranges
* token counts
* language metadata

Session

Stores:

* engineering conversations
* repository-scoped memory

Message

Stores:

* user messages
* assistant responses
* citations

IndexJob

Stores:

* indexing lifecycle
* processing metrics
* failures

⸻

18. Observability

Monitoring

* Sentry
* OpenTelemetry
* request correlation IDs
* structured logs

Metrics

Track:

* retrieval latency
* embedding latency
* indexing duration
* token usage
* context assembly latency
* streaming response latency
* failed retrievals

⸻

19. Security

Read-Only Boundary

* no shell execution
* no file modification
* no arbitrary code execution

Secret Protection

Skip indexing:

* .env files
* private keys
* credentials
* secret configuration

Sensitive values are redacted before persistence.

⸻

20. Cost Controls

Embedding Optimization

* chunk deduplication
* incremental re-indexing
* batching
* retrieval caching

Token Optimization

* strict token budgeting
* context compression
* ranked retrieval

Repository Limits

* max repository size
* max chunk count
* max indexed file size

⸻

21. Retrieval Evaluation

Metrics

Precision@K

Measures retrieval quality.

Citation Accuracy

Ensures answers are grounded.

Retrieval Latency

Measures semantic retrieval speed.

Hallucination Rate

Measures unsupported AI responses.

Context Quality

Measures usefulness of assembled context.

⸻

22. Current Development Priorities

Current Focus

* repository intelligence
* semantic retrieval
* context orchestration
* grounded AI reasoning
* session memory

Deferred Until V2

* autonomous execution
* repository modification
* multi-agent systems
* tool execution
* deployment automation
* IDE plugins
* distributed orchestration

⸻

23. Future Scope

Future Retrieval Work

* graph-aware retrieval
* symbol graph reasoning
* long-context orchestration
* cross-repository retrieval

Future Agent Work

* controlled code modification
* approval workflows
* autonomous planning
* PR generation
* debugging agents

Future Developer Experience

* VS Code extension
* architecture visualizations
* repository replay systems
* engineering timelines

Future Infrastructure

* multi-tenant architecture
* distributed indexing
* advanced observability
* enterprise deployment support
* self-hosted models