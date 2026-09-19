import { defineConfig } from '@playwright/test';

// The non-coder walkthrough (M2 exit), run by `node scripts/e2e.mjs --walkthrough`
// against the testbed's dashboard. It drives an installed browser: Edge by
// default (WALKTHROUGH_CHANNEL=chrome for Chrome), with a throwaway profile.
export default defineConfig({
  testDir: '.',
  testMatch: 'walkthrough.spec.mjs',
  timeout: 45 * 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:18090',
    channel: process.env.WALKTHROUGH_CHANNEL ?? 'msedge',
    headless: process.env.WALKTHROUGH_HEADED !== '1',
    viewport: { width: 1280, height: 860 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: '../../node_modules/.cache/walkthrough',
});
