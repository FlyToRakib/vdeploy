import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MAX_UPLOAD_BYTES, uploadRule } from '@vdeploy/contracts';

export interface Packed {
  archive: Buffer;
  files: number;
  /** Secrets files left on this computer, by path inside the folder. */
  secretsLeftOut: string[];
  /** Links, which an archive of a folder should not carry: they point anywhere. */
  linksLeftOut: string[];
}

/** One ustar header: 512 bytes, the fields at their fixed offsets. */
function header(path: string, size: number, mode: number, mtime: number): Buffer {
  const block = Buffer.alloc(512);
  // Names past 100 bytes are split at a slash into prefix (155) and name (100).
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', 155);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
    if (cut < 0 || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`${path} is too long a path to put in an archive`);
    }
  }
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode & 0o777, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(mtime, 12), 136, 12, 'ascii');
  block.fill(' ', 148, 156); // the checksum is summed with itself as spaces
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return block;
}

/**
 * A folder as a .tar.gz, by the same rule the dashboard uses when a folder
 * is dropped on it: no dependencies that are installed on the server
 * anyway, no version-control history, and no secrets files.
 */
export function packFolder(folder: string): Packed {
  const blocks: Buffer[] = [];
  const secretsLeftOut: string[] = [];
  const linksLeftOut: string[] = [];
  let files = 0;
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      const path = relative(folder, full).split(sep).join('/');
      const rule = uploadRule(path);
      if (rule === 'skip') continue;
      if (entry.isSymbolicLink()) {
        linksLeftOut.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (rule === 'secret') {
        secretsLeftOut.push(path);
        continue;
      }
      const stat = statSync(full);
      const body = readFileSync(full);
      total += body.length;
      if (total > MAX_UPLOAD_BYTES * 4) {
        throw new Error(
          'This folder is far larger than an app upload can be; is it the right one?',
        );
      }
      blocks.push(header(path, body.length, stat.mode, Math.floor(stat.mtimeMs / 1000)), body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
      files += 1;
    }
  };
  walk(folder);
  blocks.push(Buffer.alloc(1024)); // two empty blocks end an archive
  return { archive: gzipSync(Buffer.concat(blocks)), files, secretsLeftOut, linksLeftOut };
}
