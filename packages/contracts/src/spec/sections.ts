import { z } from 'zod';
import { idSchema } from '../ids.js';
import { Cpu, Duration, Memory } from './quantities.js';

/** DNS label: used in hostnames, container names and network names. */
export const ResourceName = z
  .string()
  .regex(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, 'lowercase letters, digits and hyphens, max 63');

export const Hostname = z
  .string()
  .max(253)
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'must be a lowercase hostname like app.example.com',
  );

/** Absolute container path without traversal. */
export const ContainerPath = z
  .string()
  .max(1024)
  .regex(/^\/[^\0]*$/, 'must be an absolute path')
  .refine((p) => !p.split('/').includes('..'), 'must not contain ..');

const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/, 'must be a valid variable name');

const Cidr = z.union([z.cidrv4(), z.cidrv6(), z.ipv4(), z.ipv6()]);

export const Source = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('git'),
    provider: z.enum(['github']),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name'),
    branch: z.string().min(1).max(255).default('main'),
    autoDeploy: z.boolean().default(true),
    paths: z.array(z.string().min(1).max(255)).max(32).default([]),
  }),
  z.strictObject({
    type: z.literal('image'),
    image: z.string().min(1).max(512),
  }),
  z.strictObject({
    type: z.literal('template'),
    template: ResourceName,
  }),
  z.strictObject({
    type: z.literal('archive'),
    uploadId: idSchema('upload'),
  }),
]);

export const Build = z.strictObject({
  strategy: z.enum(['dockerfile', 'nixpacks', 'compose', 'image', 'static']),
  dockerfile: z.string().max(512).optional(),
  context: z.string().max(512).default('.'),
  target: z.string().max(128).optional(),
  args: z.record(EnvKey, z.string().max(4096)).default({}),
  secrets: z.array(ResourceName).max(32).default([]),
  cache: z.enum(['registry', 'local', 'none']).default('registry'),
  builder: idSchema('server').optional(),
});

const EnvEntry = z.union([
  z.strictObject({ key: EnvKey, value: z.string().max(32_768) }),
  z.strictObject({
    key: EnvKey,
    secretRef: idSchema('secret'),
    version: z.number().int().positive().optional(),
  }),
]);

export const Runtime = z.strictObject({
  replicas: z.number().int().min(0).max(64).default(1),
  command: z.array(z.string().max(4096)).min(1).max(64).nullable().default(null),
  user: z
    .string()
    .regex(/^\d{1,10}(:\d{1,10})?$/, 'must be uid or uid:gid')
    .optional(),
  resources: z
    .strictObject({
      cpu: z.strictObject({ request: Cpu.default(0.25), limit: Cpu.default(1) }).prefault({}),
      memory: z
        .strictObject({ request: Memory.default('256Mi'), limit: Memory.default('512Mi') })
        .prefault({}),
    })
    .prefault({}),
  restartPolicy: z.enum(['unless-stopped', 'always', 'on-failure', 'no']).default('unless-stopped'),
  stopGracePeriod: Duration.default('30s'),
  env: z.array(EnvEntry).max(512).default([]),
  volumes: z
    .array(
      z.strictObject({
        name: ResourceName,
        mountPath: ContainerPath,
        size: Memory.optional(),
      }),
    )
    .max(16)
    .default([]),
  links: z
    .array(z.strictObject({ service: idSchema('database'), as: EnvKey }))
    .max(16)
    .default([]),
});

export const Network = z.strictObject({
  containerPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['http', 'tcp']).default('http'),
  domains: z
    .array(
      z.strictObject({
        host: Hostname,
        tls: z
          .strictObject({
            provider: z.enum(['letsencrypt', 'none']).default('letsencrypt'),
            challenge: z.enum(['http-01', 'dns-01']).default('http-01'),
          })
          .prefault({}),
        paths: z
          .array(z.string().regex(/^\/[\w\-./]*$/))
          .min(1)
          .max(16)
          .default(['/']),
      }),
    )
    .max(32)
    .default([]),
  middleware: z
    .strictObject({
      rateLimit: z
        .strictObject({
          average: z.number().int().positive(),
          burst: z.number().int().positive(),
        })
        .optional(),
      compression: z.boolean().default(true),
      ipAllowList: z.array(Cidr).max(256).default([]),
      headers: z
        .strictObject({ hsts: z.boolean().default(true), frameDeny: z.boolean().default(true) })
        .prefault({}),
    })
    .prefault({}),
  loadBalancer: z
    .strictObject({
      algorithm: z.enum(['wrr']).default('wrr'),
      sticky: z
        .strictObject({
          enabled: z.boolean().default(false),
          cookie: ResourceName.default('vd-sticky'),
        })
        .prefault({}),
      healthCheck: z
        .strictObject({
          path: z.string().regex(/^\//).default('/'),
          interval: Duration.default('10s'),
          timeout: Duration.default('3s'),
        })
        .optional(),
      circuitBreaker: z
        .string()
        .regex(/^NetworkErrorRatio\(\) > 0\.\d{1,2}$/, 'must be NetworkErrorRatio() > 0.NN')
        .optional(),
      retry: z.strictObject({ attempts: z.number().int().min(1).max(5) }).optional(),
    })
    .prefault({}),
});

const Probe = z.strictObject({
  type: z.enum(['http', 'tcp']),
  path: z.string().regex(/^\//).optional(),
  interval: Duration.default('10s'),
  timeout: Duration.default('3s'),
  failureThreshold: z.number().int().min(1).max(20).default(3),
});

export const Health = z.strictObject({
  startup: Probe.extend({
    timeout: Duration.default('60s'),
    interval: Duration.default('2s'),
  }).optional(),
  liveness: Probe.optional(),
  readiness: Probe.optional(),
});

export const Deploy = z.strictObject({
  strategy: z.enum(['blueGreen', 'canary', 'rolling', 'recreate']).default('blueGreen'),
  canary: z
    .strictObject({
      steps: z.array(z.number().int().min(1).max(100)).min(1).max(10),
      stepDuration: Duration,
      autoRollbackErrorRate: z.number().min(0).max(1),
    })
    .optional(),
  drainPeriod: Duration.default('30s'),
  timeout: Duration.default('10m'),
  autoRollback: z.boolean().default(true),
});

export const Scaling = z.strictObject({
  mode: z.enum(['manual', 'rules']).default('manual'),
  rules: z
    .array(
      z.strictObject({
        metric: z.enum(['cpu', 'memory', 'rps']),
        above: z.number().positive().optional(),
        below: z.number().positive().optional(),
        forDuration: Duration,
        scaleTo: z.string().regex(/^[+-][1-9]\d?$/, 'must be +N or -N'),
      }),
    )
    .max(16)
    .default([]),
  min: z.number().int().min(0).max(64).default(1),
  max: z.number().int().min(1).max(64).default(1),
});

export const Schedule = z.strictObject({
  crons: z
    .array(
      z.strictObject({
        name: ResourceName,
        command: z.array(z.string().max(4096)).min(1).max(64),
        expr: z.string().regex(/^(\S+\s+){4}\S+$/, 'must be a five-field cron expression'),
        timezone: z.string().min(1).max(64).default('UTC'),
      }),
    )
    .max(32)
    .default([]),
});

export const Placement = z.strictObject({
  server: idSchema('server').optional(),
});

export const AiSettings = z.strictObject({
  managed: z.boolean().default(true),
  autoApply: z
    .array(z.enum(['safe', 'sensitive']))
    .max(2)
    .default(['safe']),
});
