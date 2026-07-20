import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseRepositoryIdentifier,
  validateRepositoryName,
  validateRepositoryOwner,
} from "../contracts/repositoryContracts.js";

describe("repository contracts", () => {
  it("accepts a valid owner", () => {
    assert.equal(validateRepositoryOwner("acme-org-1"), "acme-org-1");
  });

  it("rejects an invalid owner", () => {
    assert.throws(() => validateRepositoryOwner("acme/org"));
    assert.throws(() => validateRepositoryOwner("acme@org"));
    assert.throws(() => validateRepositoryOwner("acme_org"));
  });

  it("accepts a valid repo", () => {
    assert.equal(validateRepositoryName("giro.backend-1"), "giro.backend-1");
  });

  it("rejects an invalid repo", () => {
    assert.throws(() => validateRepositoryName("giro backend"));
    assert.throws(() => validateRepositoryName("giro/backend"));
  });

  it("rejects empty values", () => {
    assert.throws(() => validateRepositoryOwner(""));
    assert.throws(() => validateRepositoryName("   "));
    assert.throws(() => parseRepositoryIdentifier("acme/"));
  });

  it("trims whitespace", () => {
    assert.equal(validateRepositoryOwner("  acme  "), "acme");
    assert.equal(validateRepositoryName("\tdemo\n"), "demo");
    assert.deepEqual(parseRepositoryIdentifier("  acme/demo  "), {
      owner: "acme",
      repo: "demo",
    });
  });

  it("parses repository identifiers deterministically", () => {
    const identifier = " acme-org/demo.repo ";
    const first = parseRepositoryIdentifier(identifier);
    const second = parseRepositoryIdentifier(identifier);

    assert.deepEqual(first, { owner: "acme-org", repo: "demo.repo" });
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
});
