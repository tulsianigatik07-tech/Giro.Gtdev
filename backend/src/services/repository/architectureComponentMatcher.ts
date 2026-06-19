import type {
    ArchitectureComponentRule,
    ArchitectureComponentMatch,
  } from "./architectureComponentTypes.js";
  
  export function matchFileToComponent(
    filePath: string,
    rules: readonly ArchitectureComponentRule[],
  ): ArchitectureComponentMatch | null {
    for (const rule of rules) {
      const matched = rule.filePatterns.some((pattern) => {
        const normalized = pattern.replace("/**", "");
        return filePath.startsWith(normalized);
      });
  
      if (matched) {
        return {
          filePath,
          componentName: rule.componentName,
          confidence: 1,
        };
      }
    }
  
    return null;
  }