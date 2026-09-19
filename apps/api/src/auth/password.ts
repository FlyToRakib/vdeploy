import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters: 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword({
  hash: stored,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    // A malformed stored hash is a failed verification, never a crash.
    return false;
  }
}
