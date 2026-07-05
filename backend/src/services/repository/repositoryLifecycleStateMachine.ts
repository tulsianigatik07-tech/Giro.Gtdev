export type RepositoryLifecycleMachineState =
  | "disconnected"
  | "connected"
  | "indexing"
  | "indexed"
  | "ready"
  | "stale"
  | "reindexing"
  | "cleanup_pending"
  | "cleaning"
  | "cleaned"
  | "failed";

export type RepositoryLifecycleMachineAction =
  | "connect"
  | "start_indexing"
  | "index_success"
  | "index_failed"
  | "mark_stale"
  | "start_reindex"
  | "reindex_success"
  | "request_cleanup"
  | "start_cleanup"
  | "cleanup_success"
  | "cleanup_failed"
  | "reset";

export interface RepositoryLifecycleTransitionResult {
  from: RepositoryLifecycleMachineState;
  action: RepositoryLifecycleMachineAction;
  to: RepositoryLifecycleMachineState;
  valid: boolean;
  reason: string;
}

const TRANSITIONS: Record<
  RepositoryLifecycleMachineState,
  Partial<Record<RepositoryLifecycleMachineAction, RepositoryLifecycleMachineState>>
> = {
  disconnected: {
    connect: "connected",
    reset: "disconnected",
  },
  connected: {
    start_indexing: "indexing",
    request_cleanup: "cleanup_pending",
    reset: "disconnected",
  },
  indexing: {
    index_success: "indexed",
    index_failed: "failed",
    reset: "disconnected",
  },
  indexed: {
    mark_stale: "stale",
    request_cleanup: "cleanup_pending",
    reset: "disconnected",
  },
  ready: {
    mark_stale: "stale",
    request_cleanup: "cleanup_pending",
    reset: "disconnected",
  },
  stale: {
    start_reindex: "reindexing",
    request_cleanup: "cleanup_pending",
    reset: "disconnected",
  },
  reindexing: {
    reindex_success: "ready",
    index_failed: "failed",
    reset: "disconnected",
  },
  cleanup_pending: {
    start_cleanup: "cleaning",
    cleanup_failed: "failed",
    reset: "disconnected",
  },
  cleaning: {
    cleanup_success: "cleaned",
    cleanup_failed: "failed",
    reset: "disconnected",
  },
  cleaned: {
    connect: "connected",
    reset: "disconnected",
  },
  failed: {
    start_indexing: "indexing",
    start_reindex: "reindexing",
    request_cleanup: "cleanup_pending",
    reset: "disconnected",
  },
};

function validReason(
  from: RepositoryLifecycleMachineState,
  action: RepositoryLifecycleMachineAction,
  to: RepositoryLifecycleMachineState,
): string {
  return `Transition ${from} --${action}--> ${to} is allowed.`;
}

function invalidReason(
  from: RepositoryLifecycleMachineState,
  action: RepositoryLifecycleMachineAction,
): string {
  return `Action ${action} is not allowed from state ${from}.`;
}

export function transitionRepositoryLifecycleState(
  currentState: RepositoryLifecycleMachineState,
  action: RepositoryLifecycleMachineAction,
): RepositoryLifecycleTransitionResult {
  const to = TRANSITIONS[currentState][action];

  if (!to) {
    return {
      from: currentState,
      action,
      to: currentState,
      valid: false,
      reason: invalidReason(currentState, action),
    };
  }

  return {
    from: currentState,
    action,
    to,
    valid: true,
    reason: validReason(currentState, action, to),
  };
}

export function canTransitionRepositoryLifecycleState(
  currentState: RepositoryLifecycleMachineState,
  action: RepositoryLifecycleMachineAction,
): boolean {
  return transitionRepositoryLifecycleState(currentState, action).valid;
}

export function listAllowedRepositoryLifecycleActions(
  currentState: RepositoryLifecycleMachineState,
): RepositoryLifecycleMachineAction[] {
  return Object.keys(TRANSITIONS[currentState]).sort(
    (a, b) => a.localeCompare(b),
  ) as RepositoryLifecycleMachineAction[];
}
