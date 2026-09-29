import { z } from 'zod';

/**
 * What a server is actually made of, as opposed to what it is doing (§18
 * server health panel).
 *
 * The usage readings (§27) answer "is it busy?" every thirty seconds. This
 * answers a different question, asked far less often and far more urgently:
 * **the disk is filling up — with what, and what is safe to remove?** A
 * self-hosted box does not die of CPU. It dies of a full disk, and the
 * things filling it are almost never the apps.
 *
 * Measuring it walks the filesystem, so it is taken on its own slow pace and
 * carries the time it was taken: a number from ten minutes ago, labelled as
 * such, is worth more than a fresh one that cost a stall.
 */

/** How the kernel says the machine is loaded, against how many cores it has. */
export const LoadAverage = z.strictObject({
  one: z.number().min(0),
  five: z.number().min(0),
  fifteen: z.number().min(0),
  cpus: z.number().int().min(0),
});

/**
 * What Docker is holding, from its own accounting. `reclaimable` is what it
 * says could go — VDeploy never acts on that number directly, because
 * Docker does not know which images are rollback targets.
 */
export const DockerDisk = z.strictObject({
  imagesBytes: z.number().int().min(0),
  imagesReclaimableBytes: z.number().int().min(0),
  containersBytes: z.number().int().min(0),
  /** Permanent folders VDeploy made, and nothing else. */
  volumesBytes: z.number().int().min(0),
  /**
   * What builds keep between runs: the Engine's own builder cache and the
   * volume BuildKit writes to, which is where almost all of it actually is.
   */
  buildCacheBytes: z.number().int().min(0),
  buildCacheReclaimableBytes: z.number().int().min(0),
  /** Volumes on this server that VDeploy did not make, so the total adds up. */
  otherBytes: z.number().int().min(0),
});

/**
 * A permanent folder whose app is gone (§17.2). Deleting a project never
 * deletes its data, which is right — and it means these accumulate, unseen,
 * until a disk fills. Seen, they are a choice somebody can make.
 */
export const OrphanVolume = z.strictObject({
  volume: z.string().max(128),
  /** The project it belonged to, as its label records. */
  projectId: z.string().max(64),
  sizeBytes: z.number().int().min(0),
  createdAt: z.string().max(64),
});
export type OrphanVolume = z.infer<typeof OrphanVolume>;

/**
 * What freeing disk actually freed (§18). Measured by asking Docker what
 * its disk held before and after, never added up from what was deleted —
 * an estimate of freed space is the one number nobody would forgive.
 */
export const ReclaimResult = z.strictObject({
  requestId: z.string().max(64),
  ok: z.boolean(),
  imagesRemoved: z.number().int().min(0),
  bytesFreed: z.number().int().min(0),
  /** The more reassuring number: what was left alone. */
  imagesKept: z.number().int().min(0),
  at: z.iso.datetime({ offset: true }),
  error: z.string().max(2048).optional(),
});
export type ReclaimResult = z.infer<typeof ReclaimResult>;

/**
 * What the server's own firewall lets through (§20 Servers, §30).
 *
 * Supporting detail, never the verdict: the check that matters is the one
 * from outside (§30 ③). This says *why* — a port open here and still
 * unreachable means the provider's firewall, not this server's.
 */
export const FirewallReport = z.strictObject({
  /** "ufw", "firewalld", or empty when VDeploy cannot tell. */
  tool: z.string().max(32),
  active: z.boolean(),
  openPorts: z.array(z.number().int().min(1).max(65535)).max(64),
  /** False when a firewall is there but its rules could not be read. */
  readable: z.boolean(),
});
export type FirewallReport = z.infer<typeof FirewallReport>;

/** One certificate the router serves, and when it stops being trusted (§30 ⑦). */
export const ServedCertificate = z.strictObject({
  hosts: z.array(z.string().min(1).max(253)).min(1).max(100),
  notAfter: z.iso.datetime({ offset: true }),
});
export type ServedCertificate = z.infer<typeof ServedCertificate>;

export const ServerHealth = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  load: LoadAverage,
  /**
   * Swap in use is not a problem by itself; swap in use *and* memory full
   * is a machine about to stop answering.
   */
  swapUsedBytes: z.number().int().min(0),
  swapTotalBytes: z.number().int().min(0),
  /**
   * A disk can be out of inodes with space left on it, and the error a
   * person sees then ("no space left on device") is a lie about the cause.
   */
  inodesUsed: z.number().int().min(0),
  inodesTotal: z.number().int().min(0),
  docker: DockerDisk,
  orphans: z.array(OrphanVolume).max(100),
  /** How much each app's permanent folder holds (§17.2); absent from older agents. */
  folders: z
    .array(
      z.strictObject({
        projectId: z.string().max(64),
        name: z.string().max(128),
        sizeBytes: z.number().int().min(0),
      }),
    )
    .max(200)
    .optional(),
  /** What the server's own firewall lets in; absent from older agents. */
  firewall: FirewallReport.optional(),
  /** The certificates its router serves; absent from older agents. */
  certificates: z.array(ServedCertificate).max(500).optional(),
});
export type ServerHealth = z.infer<typeof ServerHealth>;
