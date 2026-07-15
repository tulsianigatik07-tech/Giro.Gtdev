import type { IndexingJob, IndexingJobStore } from "../jobs/indexingJobStore.js";

export type IndexingProgressEventName =
  | "progress"
  | "completed"
  | "failed"
  | "heartbeat";

export type IndexingProgressStage =
  | "queued"
  | "cloning"
  | "parsing"
  | "chunking"
  | "embedding"
  | "uploading_vectors"
  | "finalizing"
  | "completed"
  | "failed";

export interface IndexingProgressEventData {
  jobId: string;
  repositoryId: string;
  stage: IndexingProgressStage;
  percentage: number;
  message: string;
  timestamp: string;
}

export interface IndexingProgressEvent {
  event: IndexingProgressEventName;
  data: IndexingProgressEventData;
}

export interface IndexingProgressPublisherMetrics {
  incrementActiveSseClients(): void;
  decrementActiveSseClients(): void;
  incrementPublishedProgressEvents(): void;
  incrementSseStreams(outcome: "completed" | "failed"): void;
}

export interface IndexingProgressPublisherLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}

export type IndexingProgressEventListener = (
  event: IndexingProgressEvent,
) => void | Promise<void>;

export interface IndexingProgressSubscription {
  unsubscribe(): void;
  readonly closed: Promise<void>;
}

export interface IndexingProgressPublisherOptions {
  jobStore: IndexingJobStore;
  metrics: IndexingProgressPublisherMetrics;
  logger: IndexingProgressPublisherLogger;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
}

interface Subscriber {
  id: number;
  repositoryId: string;
  listener: IndexingProgressEventListener;
  latest: IndexingProgressEventData;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  queue: Promise<void>;
  resolveClosed: () => void;
  closed: boolean;
}

interface RepositoryObservation {
  fingerprint: string;
  lastEventKey: string;
  pollTimer: ReturnType<typeof setInterval>;
  polling: boolean;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

function jobFingerprint(job: IndexingJob): string {
  return JSON.stringify([
    job.jobId,
    job.status,
    job.currentStage,
    job.progress,
    job.failure?.code ?? null,
    job.failure?.message ?? null,
  ]);
}

function publicProgress(
  job: IndexingJob,
): { stage: IndexingProgressStage; percentage: number; message: string } {
  if (job.status === "failed") {
    return {
      stage: "failed",
      percentage: job.progress,
      message: job.failure?.message ?? "Indexing failed.",
    };
  }
  if (job.status === "succeeded" || job.currentStage === "complete") {
    return { stage: "completed", percentage: 100, message: "Indexing completed." };
  }
  if (job.status === "queued" || job.status === "claimed") {
    return { stage: "queued", percentage: 0, message: "Indexing job queued." };
  }

  switch (job.currentStage) {
    case "pending":
      return { stage: "queued", percentage: 0, message: "Indexing job queued." };
    case "clone":
      return { stage: "cloning", percentage: 10, message: "Cloning repository." };
    case "scan":
      return { stage: "parsing", percentage: 25, message: "Parsing repository files." };
    case "structure":
    case "symbols":
    case "graph":
    case "chunk":
      return { stage: "chunking", percentage: 40, message: "Chunking repository content." };
    case "embed":
      return { stage: "embedding", percentage: 65, message: "Generating embeddings." };
    case "finalize":
      return { stage: "finalizing", percentage: 95, message: "Finalizing repository index." };
  }
}

function eventName(job: IndexingJob): IndexingProgressEventName {
  if (job.status === "failed") return "failed";
  if (job.status === "succeeded") return "completed";
  return "progress";
}

function eventKey(event: IndexingProgressEvent): string {
  return JSON.stringify([
    event.data.jobId,
    event.event,
    event.data.stage,
    event.data.percentage,
    event.data.message,
  ]);
}

export class IndexingProgressPublisher {
  private readonly jobStore: IndexingJobStore;
  private readonly metrics: IndexingProgressPublisherMetrics;
  private readonly logger: IndexingProgressPublisherLogger;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly subscribers = new Map<string, Map<number, Subscriber>>();
  private readonly observations = new Map<string, RepositoryObservation>();
  private nextSubscriberId = 1;

  constructor(options: IndexingProgressPublisherOptions) {
    this.jobStore = options.jobStore;
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  subscribe(
    initialJob: IndexingJob,
    listener: IndexingProgressEventListener,
  ): IndexingProgressSubscription {
    const repositoryId = initialJob.repositoryId;
    const id = this.nextSubscriberId++;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const replay = this.eventFromJob(initialJob);
    const subscriber: Subscriber = {
      id,
      repositoryId,
      listener,
      latest: replay.data,
      queue: Promise.resolve(),
      resolveClosed,
      closed: false,
    };

    let repositorySubscribers = this.subscribers.get(repositoryId);
    if (!repositorySubscribers) {
      repositorySubscribers = new Map();
      this.subscribers.set(repositoryId, repositorySubscribers);
    }
    repositorySubscribers.set(id, subscriber);
    this.metrics.incrementActiveSseClients();
    this.logger.info("indexing_sse_subscriber_connected", {
      jobId: initialJob.jobId,
      repositoryId,
      subscriberId: id,
    });

    if (!this.observations.has(repositoryId)) {
      const pollTimer = setInterval(() => {
        void this.pollRepository(repositoryId);
      }, this.pollIntervalMs);
      this.observations.set(repositoryId, {
        fingerprint: jobFingerprint(initialJob),
        lastEventKey: eventKey(replay),
        pollTimer,
        polling: false,
      });
    }

    subscriber.heartbeatTimer = setInterval(() => {
      const event: IndexingProgressEvent = {
        event: "heartbeat",
        data: {
          ...subscriber.latest,
          message: "Indexing stream heartbeat.",
          timestamp: this.now().toISOString(),
        },
      };
      this.enqueue(subscriber, event);
    }, this.heartbeatIntervalMs);

    queueMicrotask(() => this.enqueue(subscriber, replay));

    return {
      unsubscribe: () => this.removeSubscriber(subscriber, "disconnected"),
      closed,
    };
  }

  async publish(job: IndexingJob): Promise<void> {
    const observation = this.observations.get(job.repositoryId);
    const fingerprint = jobFingerprint(job);
    if (observation?.fingerprint === fingerprint) return;
    if (observation) observation.fingerprint = fingerprint;

    const events = this.eventsFromJob(job);
    for (const event of events) {
      if (observation?.lastEventKey === eventKey(event)) continue;
      if (observation) observation.lastEventKey = eventKey(event);
      if (event.event === "progress") {
        this.metrics.incrementPublishedProgressEvents();
        this.logger.info("indexing_progress_published", {
          jobId: event.data.jobId,
          repositoryId: event.data.repositoryId,
          stage: event.data.stage,
          percentage: event.data.percentage,
        });
      } else if (event.event === "completed") {
        this.logger.info("indexing_completed", {
          jobId: event.data.jobId,
          repositoryId: event.data.repositoryId,
        });
      } else if (event.event === "failed") {
        this.logger.info("indexing_failed", {
          jobId: event.data.jobId,
          repositoryId: event.data.repositoryId,
          stage: event.data.stage,
        });
      }

      const current = [...(this.subscribers.get(job.repositoryId)?.values() ?? [])];
      for (const subscriber of current) {
        subscriber.latest = event.data;
        this.enqueue(subscriber, event);
      }
    }
  }

  activeSubscriberCount(repositoryId?: string): number {
    if (repositoryId !== undefined) {
      return this.subscribers.get(repositoryId)?.size ?? 0;
    }
    let count = 0;
    for (const subscribers of this.subscribers.values()) count += subscribers.size;
    return count;
  }

  private eventFromJob(job: IndexingJob): IndexingProgressEvent {
    const progress = publicProgress(job);
    return {
      event: eventName(job),
      data: {
        jobId: job.jobId,
        repositoryId: job.repositoryId,
        ...progress,
        timestamp: this.now().toISOString(),
      },
    };
  }

  private eventsFromJob(job: IndexingJob): IndexingProgressEvent[] {
    if (job.status === "running" && job.currentStage === "finalize") {
      const timestamp = this.now().toISOString();
      const base = { jobId: job.jobId, repositoryId: job.repositoryId, timestamp };
      return [
        {
          event: "progress",
          data: {
            ...base,
            stage: "uploading_vectors",
            percentage: 85,
            message: "Uploading vectors.",
          },
        },
        {
          event: "progress",
          data: {
            ...base,
            stage: "finalizing",
            percentage: 95,
            message: "Finalizing repository index.",
          },
        },
      ];
    }
    return [this.eventFromJob(job)];
  }

  private enqueue(subscriber: Subscriber, event: IndexingProgressEvent): void {
    if (subscriber.closed) return;
    subscriber.queue = subscriber.queue
      .then(async () => {
        if (subscriber.closed) return;
        await subscriber.listener(event);
        if (event.event === "completed" || event.event === "failed") {
          this.removeSubscriber(subscriber, event.event);
        }
      })
      .catch(() => {
        this.removeSubscriber(subscriber, "write_error");
      });
  }

  private removeSubscriber(
    subscriber: Subscriber,
    reason: "completed" | "failed" | "disconnected" | "write_error",
  ): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    if (subscriber.heartbeatTimer) clearInterval(subscriber.heartbeatTimer);
    const repositorySubscribers = this.subscribers.get(subscriber.repositoryId);
    repositorySubscribers?.delete(subscriber.id);
    this.metrics.decrementActiveSseClients();
    if (reason === "completed" || reason === "failed") {
      this.metrics.incrementSseStreams(reason);
    }
    this.logger.info("indexing_sse_subscriber_disconnected", {
      jobId: subscriber.latest.jobId,
      repositoryId: subscriber.repositoryId,
      subscriberId: subscriber.id,
      reason,
    });
    subscriber.resolveClosed();

    if (repositorySubscribers?.size === 0) {
      this.subscribers.delete(subscriber.repositoryId);
      const observation = this.observations.get(subscriber.repositoryId);
      if (observation) clearInterval(observation.pollTimer);
      this.observations.delete(subscriber.repositoryId);
    }
  }

  private async pollRepository(repositoryId: string): Promise<void> {
    const observation = this.observations.get(repositoryId);
    if (!observation || observation.polling) return;
    observation.polling = true;
    try {
      const latest = await this.jobStore.getLatestRepositoryJob(repositoryId);
      if (latest && jobFingerprint(latest) !== observation.fingerprint) {
        await this.publish(latest);
      }
    } catch {
      // A transient store failure must not terminate otherwise healthy streams.
    } finally {
      const current = this.observations.get(repositoryId);
      if (current) current.polling = false;
    }
  }
}
