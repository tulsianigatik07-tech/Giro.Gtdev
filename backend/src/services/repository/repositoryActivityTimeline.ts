import {
  listRepositoryLifecycleEvents,
  type RepositoryLifecycleEvent,
  type RepositoryLifecycleEventMetadata,
  type RepositoryLifecycleEventType,
} from "./repositoryLifecycleEvents.js";

export type RepositoryActivityTimelineTone =
  | "info"
  | "success"
  | "warning"
  | "error";

export interface RepositoryActivityTimelineItem {
  repositoryId: string;
  sequence: number;
  type: RepositoryLifecycleEventType;
  label: string;
  title: string;
  message: string;
  tone: RepositoryActivityTimelineTone;
  metadata: RepositoryLifecycleEventMetadata;
}

interface EventPresentation {
  label: string;
  title: string;
  tone: RepositoryActivityTimelineTone;
}

const EVENT_PRESENTATION: Record<
  RepositoryLifecycleEventType,
  EventPresentation
> = {
  repository_connected: {
    label: "Connected",
    title: "Repository connected",
    tone: "success",
  },
  repository_indexed: {
    label: "Indexed",
    title: "Repository indexed",
    tone: "success",
  },
  repository_dashboard_viewed: {
    label: "Dashboard viewed",
    title: "Dashboard summary viewed",
    tone: "info",
  },
  repository_cleanup_planned: {
    label: "Cleanup planned",
    title: "Cleanup plan created",
    tone: "info",
  },
  repository_cleanup_executed: {
    label: "Cleanup executed",
    title: "Cleanup plan executed",
    tone: "warning",
  },
  repository_cleanup_reported: {
    label: "Cleanup reported",
    title: "Cleanup report created",
    tone: "success",
  },
  repository_cleanup_failed: {
    label: "Cleanup failed",
    title: "Cleanup failed",
    tone: "error",
  },
};

function copyMetadata(
  metadata: RepositoryLifecycleEventMetadata,
): RepositoryLifecycleEventMetadata {
  return Object.fromEntries(
    Object.entries(metadata)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        Array.isArray(value)
          ? [...value].sort((a, b) => a.localeCompare(b))
          : value,
      ]),
  );
}

function sortEvents(
  events: readonly RepositoryLifecycleEvent[],
): RepositoryLifecycleEvent[] {
  return [...events].sort(
    (a, b) =>
      a.sequence - b.sequence ||
      a.repositoryId.localeCompare(b.repositoryId) ||
      a.type.localeCompare(b.type),
  );
}

export function buildRepositoryActivityTimeline(
  events: readonly RepositoryLifecycleEvent[],
): RepositoryActivityTimelineItem[] {
  return sortEvents(events).map((event) => {
    const presentation = EVENT_PRESENTATION[event.type];

    return {
      repositoryId: event.repositoryId,
      sequence: event.sequence,
      type: event.type,
      label: presentation.label,
      title: presentation.title,
      message: event.message,
      tone: presentation.tone,
      metadata: copyMetadata(event.metadata),
    };
  });
}

export function buildRepositoryActivityTimelineForRepository(
  repositoryId: string,
): RepositoryActivityTimelineItem[] {
  return buildRepositoryActivityTimeline(
    listRepositoryLifecycleEvents(repositoryId),
  );
}
