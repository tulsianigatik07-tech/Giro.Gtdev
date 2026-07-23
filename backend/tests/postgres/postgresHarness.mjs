import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DATABASE_PREFIX = "giro_test_";
const REQUIRED_ROLES = ["anon", "authenticated", "service_role"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = path.join(root, "supabase/migrations");

function requiredIntegration() {
  return process.env.GIRO_POSTGRES_INTEGRATION_REQUIRED === "1";
}

function commandAvailable(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function safeError(result, action) {
  const detail = String(result.stderr || result.stdout || "unknown PostgreSQL error")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .trim();
  return new Error(`${action}: ${detail}`);
}

function assertSafeAdminUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("GIRO_POSTGRES_TEST_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("GIRO_POSTGRES_TEST_URL must use postgres:// or postgresql://.");
  }
  const adminDatabase = decodeURIComponent(url.pathname.slice(1));
  if (!/test/i.test(adminDatabase)) {
    throw new Error("GIRO_POSTGRES_TEST_URL must target an administrative database whose name contains 'test'.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(url.hostname) && process.env.GIRO_POSTGRES_ALLOW_REMOTE_TEST_HOST !== "1") {
    throw new Error("Remote PostgreSQL test hosts require GIRO_POSTGRES_ALLOW_REMOTE_TEST_HOST=1.");
  }
  return url;
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "3" },
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

export async function postgresAvailability() {
  const rawUrl = process.env.GIRO_POSTGRES_TEST_URL;
  if (!rawUrl) {
    const reason = "GIRO_POSTGRES_TEST_URL is not configured; real PostgreSQL integration tests skipped.";
    if (requiredIntegration()) {
      throw new Error("GIRO_POSTGRES_TEST_URL is required when GIRO_POSTGRES_INTEGRATION_REQUIRED=1.");
    }
    return { available: false, reason };
  }
  const adminUrl = assertSafeAdminUrl(rawUrl);
  for (const command of ["psql", "createdb", "dropdb"]) {
    if (!commandAvailable(command)) {
      const reason = `${command} is unavailable; install PostgreSQL client tools.`;
      if (requiredIntegration() || rawUrl) throw new Error(reason);
      return { available: false, reason };
    }
  }
  const probe = runSync("psql", [adminUrl.href, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", "select 1"]);
  if (probe.status !== 0) throw safeError(probe, "Configured PostgreSQL integration environment is unavailable");
  const prerequisites = runSync("psql", [
    adminUrl.href, "-XAt", "-v", "ON_ERROR_STOP=1", "-c",
    `select
       (select count(*) from pg_roles where rolname = any(array['anon','authenticated','service_role']))::text
       || ':' ||
       (select count(*) from pg_available_extensions where name in ('vector','pg_trgm'))::text`,
  ]);
  if (prerequisites.status !== 0) throw safeError(prerequisites, "PostgreSQL prerequisite verification failed");
  if (prerequisites.stdout.trim() !== `${REQUIRED_ROLES.length}:2`) {
    throw new Error("PostgreSQL integration requires anon, authenticated, service_role roles and vector/pg_trgm extensions.");
  }
  return { available: true, adminUrl };
}

function databaseUrl(adminUrl, databaseName) {
  const url = new URL(adminUrl.href);
  url.pathname = `/${databaseName}`;
  return url;
}

export async function migrationFiles() {
  return (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

export function psql(databaseUrlValue, sql, options = {}) {
  const args = [databaseUrlValue.href ?? String(databaseUrlValue), "-XAt", "-v", "ON_ERROR_STOP=1"];
  if (options.file) {
    args.push("--single-transaction", "-f", options.file);
    if (sql) args.push("-c", sql);
  } else args.push("-c", sql);
  const result = runSync("psql", args);
  if (result.status !== 0 && !options.allowFailure) throw safeError(result, options.action ?? "PostgreSQL statement failed");
  return result;
}

export function psqlAsync(databaseUrlValue, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", [
      databaseUrlValue.href ?? String(databaseUrlValue), "-XAt", "-v", "ON_ERROR_STOP=1", "-c", sql,
    ], {
      cwd: root,
      env: { ...process.env, PGCONNECT_TIMEOUT: "3" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

export async function applyMigrations(url, options = {}) {
  const files = options.files ?? await migrationFiles();
  psql(url, `
    create table if not exists public.giro_schema_migrations (
      version text primary key,
      applied_at timestamptz not null default clock_timestamp()
    )`, { action: "Migration ledger creation failed" });
  const applied = [];
  for (const file of files) {
    const alreadyApplied = psql(url,
      `select exists(select 1 from public.giro_schema_migrations where version = '${file}')`).stdout.trim();
    if (alreadyApplied === "t") continue;
    psql(url, `insert into public.giro_schema_migrations(version) values ('${file}')`, {
      file: path.join(migrationsDirectory, file),
      action: `Migration ${file} failed`,
    });
    applied.push(file);
  }
  return applied;
}

function bootstrapSupabaseDatabase(url) {
  psql(url, `
    create schema if not exists auth;
    create or replace function auth.uid() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `, { action: "Supabase test prerequisite bootstrap failed" });
}

export async function withDisposableDatabase(availability, callback) {
  if (!availability.available) throw new Error("PostgreSQL is unavailable.");
  const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}_${randomBytes(6).toString("hex")}`;
  if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) throw new Error("Unsafe disposable database name.");
  const create = runSync("createdb", ["--maintenance-db", availability.adminUrl.href, databaseName]);
  if (create.status !== 0) throw safeError(create, "Disposable PostgreSQL database creation failed");
  const url = databaseUrl(availability.adminUrl, databaseName);
  try {
    bootstrapSupabaseDatabase(url);
    return await callback({ url, databaseName });
  } finally {
    if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) throw new Error("Refusing unsafe PostgreSQL cleanup.");
    psql(availability.adminUrl, `
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = '${databaseName}' and pid <> pg_backend_pid()
    `, { allowFailure: true });
    const drop = runSync("dropdb", ["--if-exists", "--maintenance-db", availability.adminUrl.href, databaseName]);
    if (drop.status !== 0) throw safeError(drop, "Disposable PostgreSQL database cleanup failed");
  }
}

export function scalar(url, sql) {
  return psql(url, sql).stdout.trim();
}

export function seedRepositorySql(repositoryId, ownerUserId = "user-1") {
  const [owner, name] = repositoryId.split("/");
  return `insert into public.repositories (
    repository_id, owner_user_id, repository_owner, repository_name,
    status, connected_at, updated_at
  ) values ('${repositoryId}', '${ownerUserId}', '${owner}', '${name}',
    'connected', now(), now())`;
}

export function createJobSql(repositoryId, ownerUserId = "user-1") {
  const [owner, name] = repositoryId.split("/");
  return `select job_id from public.create_indexing_job(
    '${repositoryId}', '${ownerUserId}', '${owner}', '${name}',
    'https://github.com/${repositoryId}.git', 'main', 3, null::text, null::text, 2
  )`;
}
