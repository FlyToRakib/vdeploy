import { ApplicationSpec, newId, type ApplicationSpecInput } from '@vdeploy/contracts';
import type { ProjectState } from './plan.js';

export function makeSpec(overrides: Partial<ApplicationSpecInput> = {}): ApplicationSpec {
  return ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'blog' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    network: { containerPort: 80, domains: [{ host: 'blog.example.com' }] },
    ...overrides,
  });
}

export function makeProject(spec: ApplicationSpec = makeSpec()): ProjectState {
  return { id: newId('project'), spec, currentReleaseId: newId('release') };
}
