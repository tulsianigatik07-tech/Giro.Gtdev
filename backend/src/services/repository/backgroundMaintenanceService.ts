import { cleanupSessions } from "../sessions/sessionCleanupService.js";

export interface MaintenanceJobResult {
  sessionsCleaned: number;
}

export function runBackgroundMaintenanceJobs(): MaintenanceJobResult {
  const sessionsCleaned = cleanupSessions();

  return {
    sessionsCleaned,
  };
}