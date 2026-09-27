import { z } from 'zod';
import { idSchema } from './ids.js';
import { ResourceName } from './spec/sections.js';

/**
 * Looking at what an app has written (§20 Runtime). The question behind this
 * is always the same one — "did my upload actually arrive?" — and until now
 * the only way to answer it was a shell.
 *
 * A folder is addressed the way the dashboard names it: a project and one of
 * its permanent folders, never a volume and never a path on the server. What
 * comes back describes files; nothing here reads their contents.
 */

/** A permanent folder, named the way the dashboard names it. */
export const FolderName = ResourceName;

/** How many entries one folder answers with. Past this, nobody is reading by eye. */
export const MAX_FILE_ENTRIES = 500;

/**
 * A path inside a permanent folder. The empty string is the folder itself.
 * There is no `..` in it: a browser that can climb out of the folder it was
 * given is a file browser for the whole server.
 */
export const FolderPath = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path === '' ||
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\0')),
    'a path inside the folder, with no .. in it',
  );

export const FileEntry = z.strictObject({
  name: z.string().min(1).max(255),
  /** A shortcut is shown as what it is and never followed. */
  kind: z.enum(['file', 'folder', 'link', 'other']),
  sizeBytes: z.number().int().min(0),
  modifiedAt: z.iso.datetime({ offset: true }),
  /** Where a shortcut points, as text. */
  linkTo: z.string().max(1024).nullable(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** What the agent answers a listing with. */
export const FileListResult = z.strictObject({
  requestId: z.string().max(64),
  entries: z.array(FileEntry).max(MAX_FILE_ENTRIES),
  /** The folder holds more than one screen can usefully show. */
  truncated: z.boolean(),
  error: z.string().max(2048).optional(),
});
export type FileListResult = z.infer<typeof FileListResult>;

/** One folder as the dashboard shows it. */
export const FolderListing = z.strictObject({
  projectId: idSchema('project'),
  folder: ResourceName,
  /** Where the folder is mounted in the app, so the words match the app's own. */
  mountPath: z.string().max(1024),
  path: FolderPath,
  entries: z.array(FileEntry),
  truncated: z.boolean(),
});
export type FolderListing = z.infer<typeof FolderListing>;
