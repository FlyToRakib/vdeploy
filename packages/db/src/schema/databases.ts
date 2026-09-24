import type { DatabaseEngine } from '@vdeploy/contracts';
import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  boolean,
} from 'drizzle-orm/pg-core';
import { organization } from './identity.js';
import { projects, servers, secrets } from './kernel.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * A managed database (§17.3). It is not a project: it is never deployed
 * blue/green, has no release history and no route, and it holds the one
 * thing that cannot be rebuilt — the data.
 */
export const databases = pgTable(
  'databases',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    engine: text('engine').$type<DatabaseEngine>().notNull(),
    version: text('version').notNull(),
    /** The image the agent runs, decided by the control plane. */
    image: text('image').notNull(),
    port: integer('port').notNull(),
    user: text('user').notNull(),
    /** Null for engines without logical databases (Redis). */
    dbName: text('db_name'),
    memoryLimit: text('memory_limit').notNull(),
    diskSize: text('disk_size').notNull(),
    running: boolean('running').notNull().default(true),
    /** Bumped to replace the container without changing anything else. */
    revision: integer('revision').notNull().default(0),
    /** The admin password, under this database's own data key. */
    passwordSealed: text('password_sealed').notNull(),
    passwordVersion: integer('password_version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('databases_server_name').on(t.serverId, t.name),
    index('databases_org').on(t.orgId),
  ],
);

/** The database's data key, wrapped by the installation key (§22). */
export const databaseKeys = pgTable('database_keys', {
  databaseId: text('database_id')
    .primaryKey()
    .references(() => databases.id, { onDelete: 'cascade' }),
  wrapped: text('wrapped').notNull(),
  createdAt: createdAt(),
});

/**
 * An app attached to a database: the app's network is joined to the
 * database's, and the connection string is given to the app as one of its
 * own secrets, so its releases pin it like any other value.
 */
export const databaseLinks = pgTable(
  'database_links',
  {
    databaseId: text('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The variable the app reads, DATABASE_URL by default. */
    envKey: text('env_key').notNull(),
    /** The app's own secret holding the connection string. */
    secretId: text('secret_id')
      .notNull()
      .references(() => secrets.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('database_links_unique').on(t.databaseId, t.projectId, t.envKey),
    index('database_links_project').on(t.projectId),
  ],
);
