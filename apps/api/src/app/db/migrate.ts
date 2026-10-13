import { runMigrations } from './init-db.js';

const connection = `postgres://${process.env['POSTGRES_USER']}:${process.env['POSTGRES_PASSWORD']}@${process.env['POSTGRES_HOST']}:${process.env['POSTGRES_PORT_HOST']}/${process.env['POSTGRES_DB']}`;

await runMigrations(connection, './drizzle');

process.exit(0);
