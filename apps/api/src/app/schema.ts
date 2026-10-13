import {
  pgTable,
  json,
  varchar,
  uuid,
  timestamp,
  primaryKey,
  boolean,
  unique,
  pgEnum,
  index,
  check,
  customType,
  integer,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  BoardTemplateData,
  TuNode,
  UserSettings,
} from '@tapiz/board-commons';

// One Postgres type for every role column. Team members can't be guests;
// team_members_role_chk enforces that in the database.
export const roleEnum = pgEnum('role', ['admin', 'member', 'guest']);

export type TeamRole = 'admin' | 'member';

// `timestamp` (without time zone, holding UTC) read back as an ISO-8601
// string like '2024-01-02T03:04:05.678Z'. drizzle's own mode: 'string'
// returns Postgres' text form ('2024-01-02 03:04:05.678'), which browsers
// parse as local time; the API has always sent ISO strings.
const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => 'timestamp',
  fromDriver: (value) => new Date(`${value.replace(' ', 'T')}Z`).toISOString(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: varchar('id', { length: 256 }).primaryKey(),
    name: varchar('name', { length: 256 }).notNull(),
    // always stored trimmed and lower-cased; null for guests
    email: varchar('email', { length: 320 }).unique(),
    picture: varchar('picture'),
    // scrypt$<log2N>$<r>$<p>$<salt>$<key>
    passwordHash: varchar('password_hash', { length: 255 }),
    isGuest: boolean('is_guest').notNull().default(false),
    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // sha256 hex of the emailed tokens
    emailVerifyHash: varchar('email_verify_hash', { length: 64 }).unique(),
    emailVerifyExpiresAt: timestamp('email_verify_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    passwordResetHash: varchar('password_reset_hash', { length: 64 }).unique(),
    passwordResetExpiresAt: timestamp('password_reset_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    apiTokenHash: varchar('api_token_hash', { length: 64 }).unique(),
    apiTokenCreatedAt: isoTimestamp('api_token_created_at'),
    settings: json('settings')
      .$type<UserSettings>()
      .notNull()
      .default(
        sql`'{"wheelInputMode":"auto","noteDefaults":{"backgroundColor":"#fbb980","textColor":"#000000","fontFamily":"\\"Inter\\", -apple-system, system-ui, sans-serif","bold":false,"italic":false}}'::json`,
      ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Guests have no email, password or tokens; everyone else has an email.
    check(
      'accounts_identity_chk',
      sql`(NOT ${t.isGuest} AND ${t.email} IS NOT NULL)
        OR (${t.isGuest} AND ${t.email} IS NULL AND ${t.passwordHash} IS NULL
            AND ${t.apiTokenHash} IS NULL AND ${t.passwordResetHash} IS NULL
            AND ${t.emailVerifyHash} IS NULL AND ${t.emailVerifiedAt} IS NULL)`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    // sha256(token) hex; the token itself is never stored
    id: varchar('id', { length: 64 }).primaryKey(),
    accountId: varchar('account_id', { length: 256 })
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (t) => [index('sessions_account_id_idx').on(t.accountId)],
);

export const boards = pgTable('boards', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 256 }).notNull(),
  board: json('board').$type<TuNode[]>().notNull(),
  createdAt: isoTimestamp('created_at')
    .notNull()
    .default(sql`now()`),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  public: boolean('public').notNull().default(false),
});

export const acountsToBoards = pgTable(
  'accounts_boards',
  {
    accountId: varchar('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    privateId: uuid('private_id').defaultRandom().notNull(),
    role: roleEnum('role').notNull().default('member'),
    lastAccessedAt: isoTimestamp('last_accessed_at'),
  },
  (t) => [
    primaryKey({
      columns: [t.accountId, t.boardId],
      name: 'accounts_boards_account_id_board_id',
    }),
  ],
);

export const starreds = pgTable(
  'starreds',
  {
    accountId: varchar('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({
      columns: [t.accountId, t.boardId],
      name: 'starreds_account_id_board_id',
    }),
  ],
);

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 256 }).notNull(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    accountId: varchar('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: roleEnum('role').$type<TeamRole>().notNull().default('member'),
  },
  (t) => [
    primaryKey({
      columns: [t.teamId, t.accountId],
      name: 'team_members_team_id_account_id',
    }),
    check('team_members_role_chk', sql`${t.role} IN ('admin', 'member')`),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 320 }),
    userId: varchar('user_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    boardId: uuid('board_id').references(() => boards.id, {
      onDelete: 'cascade',
    }),
    inviterId: varchar('inviter_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('member'),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique().on(t.teamId, t.userId),
    unique().on(t.boardId, t.userId),
    unique().on(t.teamId, t.email),
    unique().on(t.boardId, t.email),
  ],
);

export const boardFiles = pgTable('board_files', {
  id: uuid('id').defaultRandom().primaryKey(),
  boardId: uuid('board_id')
    .notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 256 }).notNull(),
  createdAt: isoTimestamp('created_at')
    .notNull()
    .default(sql`now()`),
});

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: varchar('type', { length: 256 }).notNull(),
  boardId: uuid('board_id').references(() => boards.id, {
    onDelete: 'cascade',
  }),
  userId: varchar('user_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  nodeId: uuid('node_id'),
  createdAt: isoTimestamp('created_at')
    .notNull()
    .default(sql`now()`),
});

export const spaces = pgTable('spaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 256 }).notNull(),
  teamId: uuid('team_id')
    .references(() => teams.id, { onDelete: 'cascade' })
    .notNull(),
  createdAt: isoTimestamp('created_at')
    .notNull()
    .default(sql`now()`),
});

export const spaceToBoards = pgTable(
  'space_boards',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({
      columns: [t.spaceId, t.boardId],
      name: 'space_boards_space_id_board_id',
    }),
  ],
);

// A template belongs to one account (personal) or one team, never both.
// created_by only records who saved it, so a team template outlives its
// creator; the scope check doesn't cover it.
export const boardTemplates = pgTable(
  'board_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 256 }).notNull(),
    description: varchar('description', { length: 2000 }),
    accountId: varchar('account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    createdBy: varchar('created_by').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    // the format version lives inside
    data: json('data').$type<BoardTemplateData>().notNull(),
    nodeCount: integer('node_count').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('board_templates_account_id_idx').on(t.accountId),
    index('board_templates_team_id_idx').on(t.teamId),
    check(
      'board_templates_scope_chk',
      sql`(${t.accountId} IS NULL) <> (${t.teamId} IS NULL)`,
    ),
  ],
);
