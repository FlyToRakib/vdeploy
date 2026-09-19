import { z } from 'zod';
import { Hostname } from './spec/sections.js';

/**
 * Wildcard-DNS services for the zero-domain fallback (§13.1 ②). Neither is
 * on the Public Suffix List; both run on a raised Let's Encrypt limit, and
 * each is the other's fallback when that limit is hit (ADR 0006).
 */
export const IP_URL_SERVICES = ['sslip.io', 'nip.io'] as const;

/**
 * How a project's instant hostname is formed from its name. One DNS label
 * only: a wildcard record (`*.apps.example.com`) covers exactly one level.
 */
export const UrlPattern = z
  .string()
  .max(48)
  .regex(
    /^[a-z0-9-]*\{project\}[a-z0-9-]*$/,
    'use {project} with optional letters, digits or hyphens around it, like {project}-app',
  );

/** A base domain for instant URLs: a plain hostname, without the leading `*.`. */
export const BaseDomain = Hostname.refine((host) => !host.startsWith('*.'), {
  message: 'enter the domain without the leading *.',
});

/**
 * Instant URLs for an organization (§13.1). `ip` needs no domain at all and
 * is the default; `wildcard` puts every project on the org's own domain
 * after one DNS record; `off` gives projects no automatic URL.
 */
export const UrlSettings = z
  .strictObject({
    mode: z.enum(['ip', 'wildcard', 'off']).default('ip'),
    baseDomain: BaseDomain.nullable().default(null),
    pattern: UrlPattern.default('{project}'),
    ipService: z.enum(IP_URL_SERVICES).default('sslip.io'),
  })
  .refine((s) => s.mode !== 'wildcard' || s.baseDomain !== null, {
    message: 'a wildcard URL needs a base domain, like apps.example.com',
    path: ['baseDomain'],
  });
export type UrlSettings = z.infer<typeof UrlSettings>;

export const DEFAULT_URL_SETTINGS: UrlSettings = UrlSettings.parse({});
