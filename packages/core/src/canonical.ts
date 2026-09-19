import { createHash } from 'node:crypto';
import { canonicalJson } from '@vdeploy/contracts';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
