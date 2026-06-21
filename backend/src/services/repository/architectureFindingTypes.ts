export type ArchitectureFindingSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface ArchitectureFinding {
  title: string;
  severity: ArchitectureFindingSeverity;
  description: string;
  recommendation: string;
}