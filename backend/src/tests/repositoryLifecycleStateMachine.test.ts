import { describe, expect, it } from "vitest";

import {
  canTransitionRepositoryLifecycleState,
  listAllowedRepositoryLifecycleActions,
  transitionRepositoryLifecycleState,
  type RepositoryLifecycleMachineAction,
  type RepositoryLifecycleMachineState,
} from "../services/repository/repositoryLifecycleStateMachine.js";

describe("repository lifecycle state machine", () => {
  it("allows a valid connect transition", () => {
    expect(
      transitionRepositoryLifecycleState("disconnected", "connect"),
    ).toEqual({
      from: "disconnected",
      action: "connect",
      to: "connected",
      valid: true,
      reason: "Transition disconnected --connect--> connected is allowed.",
    });
  });

  it("allows a valid indexing transition", () => {
    expect(
      transitionRepositoryLifecycleState("connected", "start_indexing"),
    ).toEqual({
      from: "connected",
      action: "start_indexing",
      to: "indexing",
      valid: true,
      reason: "Transition connected --start_indexing--> indexing is allowed.",
    });
  });

  it("allows indexed to ready through reindex success flow", () => {
    const indexed = transitionRepositoryLifecycleState("indexing", "index_success");
    const stale = transitionRepositoryLifecycleState(indexed.to, "mark_stale");
    const reindexing = transitionRepositoryLifecycleState(stale.to, "start_reindex");
    const ready = transitionRepositoryLifecycleState(
      reindexing.to,
      "reindex_success",
    );

    expect(indexed.to).toBe("indexed");
    expect(stale.to).toBe("stale");
    expect(reindexing.to).toBe("reindexing");
    expect(ready).toEqual({
      from: "reindexing",
      action: "reindex_success",
      to: "ready",
      valid: true,
      reason: "Transition reindexing --reindex_success--> ready is allowed.",
    });
  });

  it("supports stale to reindexing flow", () => {
    expect(
      transitionRepositoryLifecycleState("stale", "start_reindex"),
    ).toEqual({
      from: "stale",
      action: "start_reindex",
      to: "reindexing",
      valid: true,
      reason: "Transition stale --start_reindex--> reindexing is allowed.",
    });
  });

  it("supports cleanup flow", () => {
    const pending = transitionRepositoryLifecycleState(
      "ready",
      "request_cleanup",
    );
    const cleaning = transitionRepositoryLifecycleState(
      pending.to,
      "start_cleanup",
    );
    const cleaned = transitionRepositoryLifecycleState(
      cleaning.to,
      "cleanup_success",
    );

    expect(pending.to).toBe("cleanup_pending");
    expect(cleaning.to).toBe("cleaning");
    expect(cleaned).toEqual({
      from: "cleaning",
      action: "cleanup_success",
      to: "cleaned",
      valid: true,
      reason: "Transition cleaning --cleanup_success--> cleaned is allowed.",
    });
  });

  it("supports failed transition handling", () => {
    expect(
      transitionRepositoryLifecycleState("indexing", "index_failed"),
    ).toEqual({
      from: "indexing",
      action: "index_failed",
      to: "failed",
      valid: true,
      reason: "Transition indexing --index_failed--> failed is allowed.",
    });
    expect(canTransitionRepositoryLifecycleState("failed", "start_reindex")).toBe(
      true,
    );
  });

  it("returns deterministic failure result for invalid transitions", () => {
    expect(
      transitionRepositoryLifecycleState("disconnected", "cleanup_success"),
    ).toEqual({
      from: "disconnected",
      action: "cleanup_success",
      to: "disconnected",
      valid: false,
      reason: "Action cleanup_success is not allowed from state disconnected.",
    });
    expect(
      canTransitionRepositoryLifecycleState("disconnected", "cleanup_success"),
    ).toBe(false);
  });

  it("lists allowed actions in stable deterministic order", () => {
    expect(listAllowedRepositoryLifecycleActions("failed")).toEqual([
      "request_cleanup",
      "reset",
      "start_indexing",
      "start_reindex",
    ]);
    expect(listAllowedRepositoryLifecycleActions("failed")).toEqual(
      listAllowedRepositoryLifecycleActions("failed"),
    );
  });

  it("supports reset transition behavior from every state", () => {
    const states: RepositoryLifecycleMachineState[] = [
      "disconnected",
      "connected",
      "indexing",
      "indexed",
      "ready",
      "stale",
      "reindexing",
      "cleanup_pending",
      "cleaning",
      "cleaned",
      "failed",
    ];

    for (const state of states) {
      expect(transitionRepositoryLifecycleState(state, "reset")).toEqual({
        from: state,
        action: "reset",
        to: "disconnected",
        valid: true,
        reason: `Transition ${state} --reset--> disconnected is allowed.`,
      });
    }
  });

  it("does not mutate inputs or introduce randomness", () => {
    const state: RepositoryLifecycleMachineState = "ready";
    const action: RepositoryLifecycleMachineAction = "request_cleanup";

    const first = transitionRepositoryLifecycleState(state, action);
    const second = transitionRepositoryLifecycleState(state, action);

    expect(first).toEqual(second);
    expect(state).toBe("ready");
    expect(action).toBe("request_cleanup");
  });
});
