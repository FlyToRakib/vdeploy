/**
 * The registry an image reference names, as Docker reads it: a first path
 * part with a dot, a port or "localhost" is a host; anything else is
 * Docker Hub.
 */
export function registryOf(image: string): string {
  const name = image.split('@')[0] ?? image;
  const first = name.split('/')[0] ?? '';
  const explicit =
    name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return explicit ? first : 'docker.io';
}
