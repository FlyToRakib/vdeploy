import { z } from 'zod';

/** First-run setup: the owner account and the first organization (§34.1). */
export const SetupRequest = z.strictObject({
  name: z.string().trim().min(1, 'Enter your name').max(100),
  email: z.email('Enter a valid email address').max(254),
  password: z.string().min(12, 'Use at least 12 characters').max(128, 'Use at most 128 characters'),
  organization: z.string().trim().min(1, 'Enter an organization name').max(100),
});
export type SetupRequest = z.infer<typeof SetupRequest>;
