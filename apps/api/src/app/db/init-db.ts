import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { logError } from '../log-error.js';

export let db: PostgresJsDatabase;
export let psqlClient: postgres.Sql;

function getConnection() {
  const connection = `postgres://${process.env['POSTGRES_USER']}:${process.env['POSTGRES_PASSWORD']}@${process.env['POSTGRES_HOST']}:${process.env['POSTGRES_PORT_HOST']}/${process.env['POSTGRES_DB']}`;

  return connection;
}

// The `timestamp` (without time zone) columns hold UTC and default to now(),
// which writes the session's local time; pin the session to UTC.
const connectionParams = { TimeZone: 'UTC' };

function initDbClient() {
  const connection = getConnection();

  psqlClient = postgres(connection, { connection: connectionParams });

  db = drizzle(psqlClient);

  return db;
}

// Arbitrary key for pg_advisory_lock.
const MIGRATION_LOCK_KEY = 7_301_947;

// Generated migrations aren't idempotent (plain CREATE TYPE/TABLE), so
// processes starting at once (API instances, parallel test files) take turns;
// later ones find the migrations applied and skip them.
export async function runMigrations(
  connection: string,
  migrationsFolder: string,
) {
  const migrationClient = postgres(connection, {
    max: 1,
    connection: connectionParams,
  });

  try {
    await migrationClient`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await migrate(drizzle(migrationClient), { migrationsFolder });
  } finally {
    // closing the session releases the lock
    await migrationClient.end();
  }
}

async function dbMigrate() {
  let migrationsFolder = 'drizzle';

  // pnpm run test:e2e
  if (process.cwd().includes('apps/api')) {
    migrationsFolder = '../../drizzle';
  }

  await runMigrations(getConnection(), migrationsFolder);
}

// Resolves once the migrations ran and the client is ready, retrying until
// the database is reachable.
export async function startDB() {
  // tests seed users and delete boards, so keep them off real databases
  if (
    process.env['VITEST'] &&
    !/_test$/.test(process.env['POSTGRES_DB'] ?? '')
  ) {
    throw new Error(
      `Refusing to run DB tests against "${process.env['POSTGRES_DB']}"; set POSTGRES_DB to a database ending in _test`,
    );
  }

  for (;;) {
    try {
      await dbMigrate();
      initDbClient();

      return;
    } catch (e) {
      logError(e, 'Error connecting to DB, retrying in 2 seconds');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
