import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

import { resolveRepositoryStorageRoot } from "../config/repositoryStorage.js";
import { scanRepo } from "../services/repository/scanner.js";
import {
  collectContainedDirectories,
  removeRepositoryCheckout,
  repositoryCheckoutKey,
  repositoryCheckoutPath,
  RepositoryPathSecurityError,
  resolveRepositoryPath,
  validateRepositoryCheckout,
  type TrustedRepositoryCheckoutPath,
} from "../services/security/repositoryPaths.js";
import { validateGitWorkingDirectory } from "../services/repository/clone.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    await import("node:fs/promises").then((fs) => fs.rm(temporaryRoot, { recursive: true, force: true }));
  }
});

async function fixture() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "giro-repository-security-"));
  temporaryRoots.push(temporaryRoot);
  const storageRoot = resolveRepositoryStorageRoot(path.join(temporaryRoot, "storage"));
  const checkout = repositoryCheckoutPath("acme/demo", storageRoot);
  const sibling = path.join(storageRoot, "sibling-data");
  const external = path.join(temporaryRoot, "external");
  await mkdir(path.join(checkout, "src", "nested"), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(path.join(checkout, "src", "safe.ts"), "export const safe = true;\n", "utf8");
  await writeFile(path.join(checkout, "src", "nested", "deep.ts"), "export const deep = true;\n", "utf8");
  await writeFile(path.join(sibling, "keep.txt"), "sibling", "utf8");
  await writeFile(path.join(external, "secret.ts"), "export const secret = true;\n", "utf8");
  return { temporaryRoot, storageRoot, checkout, sibling, external };
}

async function rejectsPath(promise: Promise<unknown>, reason?: RepositoryPathSecurityError["reasonCode"]) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RepositoryPathSecurityError);
    if (reason) assert.equal(error.reasonCode, reason);
    assert.equal(error.message.includes(tmpdir()), false);
    return true;
  });
}

test("valid nested child and intentional checkout-root resolution succeed", async () => {
  const { checkout } = await fixture();
  const trusted = checkout as TrustedRepositoryCheckoutPath;
  assert.equal(await resolveRepositoryPath(trusted, "", { allowCheckoutRoot: true, mustExist: true }), checkout);
  assert.equal(await readFile(await resolveRepositoryPath(trusted, "src/nested/deep.ts", { mustExist: true, requireFile: true }), "utf8"), "export const deep = true;\n");
});

test("traversal, nested traversal, sibling-prefix, and stored malicious paths are rejected", async () => {
  const { checkout } = await fixture();
  const trusted = checkout as TrustedRepositoryCheckoutPath;
  for (const candidate of ["../outside", "src/../../outside", `../${path.basename(checkout)}-sibling/file`, "../../etc/passwd"]) {
    await rejectsPath(resolveRepositoryPath(trusted, candidate, { mustExist: false }), "path_traversal_attempt");
  }
});

test("absolute POSIX, Windows, UNC, null-byte, and encoded traversal paths are rejected", async () => {
  const { checkout } = await fixture();
  const trusted = checkout as TrustedRepositoryCheckoutPath;
  await rejectsPath(resolveRepositoryPath(trusted, "/etc/passwd"), "absolute_path_attempt");
  await rejectsPath(resolveRepositoryPath(trusted, "C:\\Windows\\system.ini"), "absolute_path_attempt");
  await rejectsPath(resolveRepositoryPath(trusted, "\\\\server\\share\\file"), "absolute_path_attempt");
  await rejectsPath(resolveRepositoryPath(trusted, "src/evil\0.ts"), "invalid_path");
  for (const candidate of ["%2e%2e%2fsecret", "%252e%252e%252fsecret"]) {
    await rejectsPath(resolveRepositoryPath(trusted, candidate), "path_traversal_attempt");
  }
});

test("safe internal file symlink resolves but external and broken symlinks are rejected", async (t) => {
  const { checkout, external } = await fixture();
  const trusted = checkout as TrustedRepositoryCheckoutPath;
  try {
    await symlink("safe.ts", path.join(checkout, "src", "internal-link.ts"));
    await symlink(path.join(external, "secret.ts"), path.join(checkout, "src", "external-link.ts"));
    await symlink("missing.ts", path.join(checkout, "src", "broken-link.ts"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Symlinks are unavailable on this platform");
    throw error;
  }
  assert.equal(await readFile(await resolveRepositoryPath(trusted, "src/internal-link.ts", { mustExist: true, requireFile: true }), "utf8"), "export const safe = true;\n");
  await rejectsPath(resolveRepositoryPath(trusted, "src/external-link.ts", { mustExist: true, requireFile: true }), "symlink_escape_attempt");
  await rejectsPath(resolveRepositoryPath(trusted, "src/broken-link.ts", { mustExist: true, requireFile: true }), "symlink_escape_attempt");
});

test("external directory symlinks are not traversed or indexed", async (t) => {
  const { checkout, external } = await fixture();
  try {
    await symlink(external, path.join(checkout, "linked-external"), "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Symlinks are unavailable on this platform");
    throw error;
  }
  const trusted = checkout as TrustedRepositoryCheckoutPath;
  assert.deepEqual(await collectContainedDirectories(trusted), ["src", "src/nested"]);
  const scan = await scanRepo(trusted);
  assert.equal(scan.files.some((file) => file.filePath.includes("secret.ts")), false);
});

test("cleanup removes only the derived checkout and never follows nested symlink targets", async (t) => {
  const { storageRoot, checkout, sibling, external } = await fixture();
  try {
    await symlink(path.join(external, "secret.ts"), path.join(checkout, "external-delete-link.ts"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Symlinks are unavailable on this platform");
    throw error;
  }
  assert.equal(await removeRepositoryCheckout("acme/demo", { storageRoot }), true);
  assert.equal(await readFile(path.join(sibling, "keep.txt"), "utf8"), "sibling");
  assert.equal(await readFile(path.join(external, "secret.ts"), "utf8"), "export const secret = true;\n");
  await assert.rejects(validateRepositoryCheckout("acme/demo", { mustExist: true, storageRoot }));
});

test("another repository checkout and unsafe pre-existing checkout symlinks are rejected", async (t) => {
  const { storageRoot, checkout, external } = await fixture();
  const other = repositoryCheckoutPath("acme/other", storageRoot);
  await mkdir(other, { recursive: true });
  await rejectsPath(resolveRepositoryPath(checkout as TrustedRepositoryCheckoutPath, `../${path.basename(other)}/file`, { mustExist: false }));
  await import("node:fs/promises").then((fs) => fs.rm(other, { recursive: true }));
  try {
    await symlink(external, other, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Symlinks are unavailable on this platform");
    throw error;
  }
  await rejectsPath(validateRepositoryCheckout("acme/other", { mustExist: true, storageRoot }), "unsafe_checkout");
});

test("checkout keys are deterministic, collision-resistant, bounded, and display-name independent", () => {
  const key = repositoryCheckoutKey("Owner/Repo.Name");
  assert.match(key, /^repo-[0-9a-f]{64}$/);
  assert.equal(key, repositoryCheckoutKey("Owner/Repo.Name"));
  assert.notEqual(key, repositoryCheckoutKey("Owner/Repo-Name"));
  assert.equal(key.includes("Owner"), false);
  assert.equal(key.includes("/"), false);
  assert.equal(key.includes(".."), false);
});

test("Git working directories require the exact derived checkout and matching top-level", async () => {
  const { storageRoot, checkout, external } = await fixture();
  const git = simpleGit(checkout);
  await git.init();
  assert.equal(await validateGitWorkingDirectory(checkout, 5_000, storageRoot), checkout);
  await git.addConfig("core.worktree", external, false, "local");
  await assert.rejects(validateGitWorkingDirectory(checkout, 5_000, storageRoot), /top-level|configuration is unsafe/i);
  await assert.rejects(validateGitWorkingDirectory(external, 5_000, storageRoot), /authorized checkout/i);
});

test("Git implementation uses argument arrays and never shell child-process interpolation", async () => {
  const source = await readFile(path.resolve("src/services/repository/clone.ts"), "utf8");
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(/\b(?:exec|spawn)\s*\(/.test(source), false);
  assert.match(source, /\.clone\(repoUrl, clonePath, \["--depth", "1"\]\)/);
  assert.match(source, /git\.reset\(\["--hard", revision\]\)/);
});
