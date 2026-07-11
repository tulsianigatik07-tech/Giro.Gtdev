export type ReadinessStatus = "ready" | "degraded" | "not_ready";
export type ReadinessCheckStatus = "pass" | "fail" | "skip";

export interface ReadinessCheckResult {
  readonly name: string;
  readonly status: ReadinessCheckStatus;
  readonly critical: boolean;
  readonly message: string;
}

export interface ApplicationReadiness {
  readonly status: ReadinessStatus;
  readonly checks: readonly ReadinessCheckResult[];
}

export interface ReadinessCheckDefinition {
  readonly name: string;
  readonly critical: boolean;
  readonly successMessage: string;
  readonly failureMessage: string;
  readonly skipMessage?: string;
  readonly check?: () => void | Promise<void>;
}

function immutableResult(
  definition: ReadinessCheckDefinition,
  status: ReadinessCheckStatus,
  message: string,
): ReadinessCheckResult {
  return Object.freeze({
    name: definition.name,
    status,
    critical: definition.critical,
    message,
  });
}

export async function checkApplicationReadiness(
  definitions: readonly ReadinessCheckDefinition[],
): Promise<ApplicationReadiness> {
  const checks: ReadinessCheckResult[] = [];

  for (const definition of definitions) {
    if (!definition.check) {
      checks.push(
        immutableResult(
          definition,
          "skip",
          definition.skipMessage ?? "Optional dependency is not configured.",
        ),
      );
      continue;
    }

    try {
      await definition.check();
      checks.push(immutableResult(definition, "pass", definition.successMessage));
    } catch {
      checks.push(immutableResult(definition, "fail", definition.failureMessage));
    }
  }

  const status: ReadinessStatus = checks.some(
    (check) => check.critical && check.status === "fail",
  )
    ? "not_ready"
    : checks.some((check) => !check.critical && check.status === "fail")
      ? "degraded"
      : "ready";

  return Object.freeze({ status, checks: Object.freeze(checks) });
}
