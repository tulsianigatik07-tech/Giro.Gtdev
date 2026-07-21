import {
  applyMigrations,
  migrationFiles,
  postgresAvailability,
  scalar,
  withDisposableDatabase,
} from "../tests/postgres/postgresHarness.mjs";

const availability = await postgresAvailability();
if (!availability.available) {
  process.stdout.write(`SKIP: ${availability.reason}\n`);
  process.exit(0);
}

await withDisposableDatabase(availability, async ({ url }) => {
  const files = await migrationFiles();
  const first = await applyMigrations(url, { files });
  const second = await applyMigrations(url, { files });
  if (first.length !== files.length || second.length !== 0) {
    throw new Error("Migration ledger verification failed.");
  }
  const installed = Number(scalar(url, "select count(*) from public.giro_schema_migrations"));
  if (installed !== files.length) throw new Error("Not every migration was recorded.");
});

process.stdout.write("PostgreSQL migration verification passed.\n");
