import type { RepositoryIntelligenceStore } from "./store.js";
import { runtimeRepositoryIntelligenceStore } from "./store.js";

export class RepositoryIntelligenceService {
  constructor(private readonly store: RepositoryIntelligenceStore = runtimeRepositoryIntelligenceStore) {}

  private async snapshot(repositoryId: string, repositoryRevision?: string) {
    return this.store.loadPublished(repositoryId, repositoryRevision);
  }

  async getArchitectureSummary(repositoryId: string, repositoryRevision?: string) {
    return (await this.snapshot(repositoryId, repositoryRevision))?.architecture ?? null;
  }

  async getSubsystemSummary(repositoryId: string, subsystemId: string, repositoryRevision?: string) {
    return (await this.snapshot(repositoryId, repositoryRevision))?.subsystems
      .find((item) => item.subsystemId === subsystemId) ?? null;
  }

  async getRepositoryOverview(repositoryId: string, repositoryRevision?: string) {
    const snapshot = await this.snapshot(repositoryId, repositoryRevision);
    if (!snapshot) return null;
    return {
      architecture: snapshot.architecture,
      codeOrganization: snapshot.codeOrganization,
      symbols: snapshot.symbols,
      quality: snapshot.quality,
      evolution: snapshot.evolution,
    };
  }

  async getEntrypoints(repositoryId: string, repositoryRevision?: string) {
    return (await this.snapshot(repositoryId, repositoryRevision))?.symbols.entrypoints ?? [];
  }

  async getDependencyHotspots(repositoryId: string, repositoryRevision?: string) {
    return (await this.snapshot(repositoryId, repositoryRevision))?.architecture.hotspots ?? [];
  }

  async getQualitySummary(repositoryId: string, repositoryRevision?: string) {
    return (await this.snapshot(repositoryId, repositoryRevision))?.quality ?? null;
  }

  async getRepositoryStatistics(repositoryId: string, repositoryRevision?: string) {
    const snapshot = await this.snapshot(repositoryId, repositoryRevision);
    return snapshot ? { ...snapshot.metrics, growth: snapshot.evolution.growth } : null;
  }

  async getLargestModules(repositoryId: string, repositoryRevision?: string) {
    return (await this.snapshot(repositoryId, repositoryRevision))?.codeOrganization.largestModules ?? [];
  }

  async getPublicApi(repositoryId: string, repositoryRevision?: string) {
    return (await this.snapshot(repositoryId, repositoryRevision))?.symbols.publicApis ?? [];
  }
}

export const runtimeRepositoryIntelligenceService = new RepositoryIntelligenceService();
