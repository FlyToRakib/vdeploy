import { readFileSync } from 'node:fs';
import type { ApiConfig } from './config.js';
import type { GithubDeps } from './kernel/context.js';

const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY_FILE',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
] as const;

/**
 * The GitHub App from the environment: all of it or none of it. Half a
 * configuration is refused at start, naming what is missing, rather than
 * failing later in front of a user.
 */
export function githubFromConfig(config: ApiConfig): GithubDeps | undefined {
  const missing = REQUIRED.filter((name) => !config[name]);
  if (missing.length === REQUIRED.length) return undefined;
  if (missing.length > 0) {
    throw new Error(`The GitHub App is half set up: also set ${missing.join(', ')}`);
  }
  return {
    app: {
      appId: config.GITHUB_APP_ID ?? '',
      privateKey: readFileSync(config.GITHUB_APP_PRIVATE_KEY_FILE ?? '', 'utf8'),
      apiUrl: config.GITHUB_API_URL.replace(/\/$/, ''),
      webUrl: config.GITHUB_WEB_URL.replace(/\/$/, ''),
      clientId: config.GITHUB_CLIENT_ID ?? '',
      clientSecret: config.GITHUB_CLIENT_SECRET ?? '',
    },
    slug: config.GITHUB_APP_SLUG ?? '',
    webhookSecret: config.GITHUB_WEBHOOK_SECRET ?? '',
  };
}
