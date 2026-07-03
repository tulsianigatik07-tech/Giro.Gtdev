import { describe, expect, it } from "vitest";

import { assessRepositoryChangeSeverity } from "../services/repository/repositoryChangeSeverity.js";

describe("repository change severity", () => {
  it("assesses change severity", () => {
    expect(
      assessRepositoryChangeSeverity({
        filesAdded: 0,
        filesModified: 0,
        filesDeleted: 0,
        totalChanges: 0,
      }),
    ).toBe("none");

    expect(
      assessRepositoryChangeSeverity({
        filesAdded: 2,
        filesModified: 1,
        filesDeleted: 0,
        totalChanges: 3,
      }),
    ).toBe("low");

    expect(
      assessRepositoryChangeSeverity({
        filesAdded: 5,
        filesModified: 5,
        filesDeleted: 0,
        totalChanges: 10,
      }),
    ).toBe("medium");

    expect(
      assessRepositoryChangeSeverity({
        filesAdded: 20,
        filesModified: 10,
        filesDeleted: 0,
        totalChanges: 30,
      }),
    ).toBe("high");
  });
});