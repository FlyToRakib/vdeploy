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
  volumesBytes: z.number().int().min(0),
  buildCacheBytes: z.number().int().min(0),
  buildCacheReclaimableBytes: z.number().int().min(0),
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
});
export type ServerHealth = z.infer<typeof ServerHealth>;
