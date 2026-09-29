import { describe, expect, it } from 'vitest';
import { imageSizeWarning, LARGE_IMAGE_BYTES } from './builds.js';

describe('a built image', () => {
  it('is worth a word once it is gigabytes, with the fix that usually works', () => {
    expect(imageSizeWarning(null)).toBeNull();
    expect(imageSizeWarning(LARGE_IMAGE_BYTES - 1)).toBeNull();
    const said = imageSizeWarning(4.2 * 1024 ** 3);
    expect(said).toMatch(/^The image is 4\.2 GB\./);
    expect(said).toMatch(/multi-stage Dockerfile/);
  });
});
