// Reads package.json signals needed for intelligence analysis. Pure I/O, no throw.

import { readFile } from "node:fs/promises";
import { resolveRepositoryPath, type TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

export interface PackageInfo {
  deps: Set<string>;
  hasBin: boolean;
  isLibrary: boolean;
}

export async function readPackageInfo(clonePath: TrustedRepositoryCheckoutPath): Promise<PackageInfo> {
  try {
    const packageFile = await resolveRepositoryPath(clonePath, "package.json", { mustExist: true, requireFile: true });
    const raw = await readFile(packageFile, "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      bin?: unknown;
      main?: unknown;
      exports?: unknown;
      scripts?: Record<string, string>;
    };
    const deps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const hasBin = pkg.bin !== undefined;
    const isLibrary = pkg.main !== undefined || pkg.exports !== undefined;
    return { deps, hasBin, isLibrary };
  } catch {
    return { deps: new Set(), hasBin: false, isLibrary: false };
  }
}
