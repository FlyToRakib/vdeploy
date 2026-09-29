import { describe, expect, it } from 'vitest';
import { readCompose } from './compose.js';

/** A file of the shape people actually have: an app, a database, a cache. */
const REAL = `
services:
  web:
    image: ghost:5-alpine
    ports:
      - "8080:2368"
    environment:
      NODE_ENV: production
      url: https://example.com
    volumes:
      - content:/var/lib/ghost/content
    depends_on:
      - db
  db:
    image: mysql:8.4
    volumes:
      - mysqldata:/var/lib/mysql
    environment:
      - MYSQL_ROOT_PASSWORD=hunter2
  cache:
    image: redis:7
volumes:
  content:
  mysqldata:
`;

describe('bringing a compose file across (§15)', () => {
  it('turns each service into an app, keeping its settings, port and folders', () => {
    const read = readCompose(REAL);
    expect(read.apps).toHaveLength(1);
    const web = read.apps[0];
    expect(web?.name).toBe('web');
    // The container's port, not the one published on the host.
    expect(web?.spec.network?.containerPort).toBe(2368);
    expect(web?.spec.runtime.env).toContainEqual({ key: 'NODE_ENV', value: 'production' });
    expect(web?.spec.runtime.volumes).toEqual([
      { name: 'content', mountPath: '/var/lib/ghost/content' },
    ]);
    expect(web?.needs).toEqual(['db']);
  });

  it('runs a database as a database, not as an app', () => {
    const read = readCompose(REAL);
    // "redis:7" becomes the 7 VDeploy actually runs, not a tag it hopes for.
    expect(read.databases).toEqual([
      { name: 'db', engine: 'mysql', version: '8.4' },
      { name: 'cache', engine: 'redis', version: '7.4' },
    ]);
    // And says so, because it is a real difference rather than a detail.
    expect(read.changed.some((n) => n.service === 'db' && n.what.includes('managed mysql'))).toBe(
      true,
    );
  });

  it('runs a MinIO service as managed object storage', () => {
    const read = readCompose(`
services:
  files:
    image: minio/minio:RELEASE.2025-09-07T16-13-09Z
    command: server /data
`);
    expect(read.apps).toEqual([]);
    expect(read.databases).toEqual([{ name: 'files', engine: 's3', version: '1.0.0' }]);
  });

  it('says a published port is not published, rather than quietly dropping it', () => {
    const read = readCompose(REAL);
    expect(read.changed.some((n) => n.service === 'web' && n.what.includes('not published'))).toBe(
      true,
    );
  });

  it('refuses what VDeploy will not run, and says what each one meant', () => {
    const read = readCompose(`
services:
  bad:
    image: nginx:1.27
    privileged: true
    cap_add: [SYS_ADMIN]
    network_mode: host
    devices:
      - /dev/kvm
`);
    const refused = Object.fromEntries(read.refused.map((n) => [n.what, n.why]));
    expect(Object.keys(refused).sort()).toEqual([
      'cap_add',
      'devices',
      'network_mode',
      'privileged',
    ]);
    // Each says what it meant, not what it was called.
    expect(refused.privileged).toContain('full control of the server');
    expect(refused.network_mode).toContain('own network');
  });

  it('will not mount a path on the server, and says where to put those files', () => {
    const read = readCompose(`
services:
  app:
    image: nginx:1.27
    volumes:
      - /etc/nginx/conf.d:/etc/nginx/conf.d
      - ./site:/usr/share/nginx/html
      - data:/data
`);
    expect(read.refused).toHaveLength(2);
    expect(read.refused[0]?.why).toContain('permanent folder');
    // The named volume still comes across.
    expect(read.apps[0]?.spec.runtime.volumes).toEqual([{ name: 'data', mountPath: '/data' }]);
  });

  it('sends a service built from a Dockerfile to its own project', () => {
    const read = readCompose(`
services:
  api:
    build: .
    ports: ["3000:3000"]
  web:
    image: nginx:1.27
`);
    expect(read.apps.map((a) => a.name)).toEqual(['web']);
    expect(read.refused.map((n) => n.what).sort()).toEqual(['build', 'no image']);
  });

  it('reads settings written either way compose allows', () => {
    const read = readCompose(`
services:
  a:
    image: nginx:1.27
    environment:
      - A=1
      - B=two
  b:
    image: nginx:1.27
    environment:
      C: 3
      D: true
`);
    expect(read.apps[0]?.spec.runtime.env).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two' },
    ]);
    expect(read.apps[1]?.spec.runtime.env).toEqual([
      { key: 'C', value: '3' },
      { key: 'D', value: 'true' },
    ]);
  });

  it('refuses a file that is not one, in words', () => {
    expect(() => readCompose('this: [is: not')).toThrow(/not a file VDeploy can read/);
    expect(() => readCompose('version: "3"')).toThrow(/no services/);
    expect(() => readCompose('services:\n  a:\n    build: .')).toThrow(/Nothing in that file/);
  });

  it('makes a name VDeploy can use out of one it cannot', () => {
    const read = readCompose(`
services:
  My_App.1:
    image: nginx:1.27
  "2nd":
    image: nginx:1.27
`);
    expect(read.apps.map((a) => a.name)).toEqual(['my-app-1', 'app-2nd']);
  });
});
