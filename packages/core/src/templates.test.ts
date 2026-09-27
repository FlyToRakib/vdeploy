import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { buildPlan } from './plan.js';
import {
  findTemplate,
  TEMPLATES,
  templateLink,
  templateSecrets,
  templateSpec,
} from './templates.js';

/** What a person actually sends: a name and the app they picked. */
const asked = (name: string, template: string) => ({
  spec: {
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name },
    source: { type: 'template', template },
    build: { strategy: 'image' },
  },
});

const server = {
  name: 'server-01',
  capacity: { memoryBytes: 8 * 1024 * 1024 * 1024, cpus: 4 },
  committed: { memoryBytes: 0, cpu: 0 },
};

describe('the template catalog (§15, §26)', () => {
  it('describes every app in words somebody would search for', () => {
    for (const template of TEMPLATES) {
      expect(template.what.length).toBeGreaterThan(20);
      expect(template.goodFor.length).toBeGreaterThan(20);
      // What is left to do afterwards is said, because there always is some.
      expect(template.afterwards.length).toBeGreaterThan(20);
      expect(template.image).toMatch(/:/);
    }
  });

  it('names the folders that must survive a deploy', () => {
    // The one mistake that turns an upgrade into a disaster: every app here
    // that writes anything says where, up front.
    for (const name of ['wordpress', 'ghost', 'n8n', 'uptime-kuma', 'vaultwarden', 'gitea']) {
      expect(findTemplate(name)?.volumes.length).toBeGreaterThan(0);
    }
  });

  it('expands into an ordinary spec, with no trace of a template left in it', () => {
    const spec = templateSpec('wordpress', 'my-blog');
    // What is stored, approved and sent to the agent is an image project.
    expect(spec.source).toEqual({ type: 'image', image: 'wordpress:6-apache' });
    expect(spec.build.strategy).toBe('image');
    expect(spec.network?.containerPort).toBe(80);
    expect(spec.runtime.volumes).toEqual([{ name: 'content', mountPath: '/var/www/html' }]);
    // Only the label remembers, and nothing reads it to decide anything.
    expect(spec.metadata.labels.template).toBe('wordpress');
    // It is a real spec, not a shape that happens to look like one.
    expect(() => ApplicationSpec.parse(spec)).not.toThrow();
  });

  it('leaves out the settings it cannot know yet', () => {
    // A database's password and a generated key do not exist at this point;
    // a spec that named them would name nothing.
    const spec = templateSpec('umami', 'stats');
    expect(spec.runtime.env.map((e) => e.key)).not.toContain('DATABASE_URL');
    expect(spec.runtime.env.map((e) => e.key)).not.toContain('APP_SECRET');
    // A fixed setting is there from the start.
    expect(templateSpec('ghost', 'letters').runtime.env).toContainEqual({
      key: 'database__client',
      value: 'mysql',
    });
  });

  it('refuses a template nobody has', () => {
    expect(() => templateSpec('not-a-real-app', 'x')).toThrow(/no template called/);
  });

  it('asks for a generated value only where a shared one would be a hole', () => {
    expect(templateSecrets('n8n')).toEqual([{ key: 'N8N_ENCRYPTION_KEY', bytes: 32 }]);
    expect(templateSecrets('vaultwarden')).toEqual([{ key: 'ADMIN_TOKEN', bytes: 48 }]);
    expect(templateSecrets('uptime-kuma')).toEqual([]);
  });

  it('knows which apps want the address in pieces and which want one URL', () => {
    expect(templateLink('umami')).toEqual({ envKey: 'DATABASE_URL' });
    expect(templateLink('wordpress')).toEqual({
      parts: {
        host: 'WORDPRESS_DB_HOST',
        user: 'WORDPRESS_DB_USER',
        password: 'WORDPRESS_DB_PASSWORD',
        name: 'WORDPRESS_DB_NAME',
      },
    });
    expect(templateLink('uptime-kuma')).toBeNull();
  });

  it('makes the generated settings between writing the spec and pinning the release', () => {
    // Any later and the app's first version would start without its own
    // encryption key, which for n8n means losing what it encrypted.
    const plan = buildPlan('project.create', asked('flows', 'n8n'), { project: null, server });
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds.indexOf('generate_secrets')).toBeGreaterThan(kinds.indexOf('update_spec'));
    expect(kinds.indexOf('generate_secrets')).toBeLessThan(kinds.indexOf('create_release'));
  });

  it('adds no such step for an app that needs nothing made up', () => {
    const plan = buildPlan('project.create', asked('watch', 'uptime-kuma'), {
      project: null,
      server,
    });
    expect(plan.steps.map((s) => s.kind)).not.toContain('generate_secrets');
    // And the plan is a plain project creation, tier and all.
    expect(plan.tier).toBe('sensitive');
  });
});
