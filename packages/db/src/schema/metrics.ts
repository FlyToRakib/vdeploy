import { doublePrecision, index, bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects, servers } from './kernel.js';

/**
 * What a server and its apps were actually using, at a moment (§27). One
 * row per project per reading, plus one with no project for the machine
 * itself. Kept for two days: long enough to answer "what happened last
 * night", short enough that nobody is storing a year of numbers nobody
 * will read.
 */
export const metricSamples = pgTable(
  'metric_samples',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Null for the server itself. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** Of one core: 250 means two and a half cores, for a project. */
    cpuPercent: doublePrecision('cpu_percent').notNull(),
    memoryBytes: bigint('memory_bytes', { mode: 'number' }).notNull(),
    /** What it is allowed: a project's limit, or the machine's memory. */
    memoryLimit: bigint('memory_limit', { mode: 'number' }).notNull(),
    /** Set only for the server: how full the disk Docker writes to is. */
    diskUsedBytes: bigint('disk_used_bytes', { mode: 'number' }),
    diskTotalBytes: bigint('disk_total_bytes', { mode: 'number' }),
    rxBytes: bigint('rx_bytes', { mode: 'number' }).notNull().default(0),
    txBytes: bigint('tx_bytes', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    index('metric_samples_project_at').on(t.projectId, t.at),
    index('metric_samples_server_at').on(t.serverId, t.at),
  ],
);
