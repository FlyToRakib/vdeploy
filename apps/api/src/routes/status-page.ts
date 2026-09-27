import { publicStatus } from '@vdeploy/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { KernelDeps } from '../kernel/context.js';

/**
 * The public status page (§18). The one page here that anybody may read
 * without signing in, so it is written as if strangers are reading it —
 * because they are.
 *
 * It answers from what was chosen and nothing else: a label somebody wrote,
 * whether the app is serving, and how much of the last ninety days it was.
 * No project ids, no addresses, no server names, no organization name it
 * was not given. A page that does not exist and one that is turned off
 * answer the same way, so the address cannot be used to find out whether an
 * organization exists.
 */
export const statusPageRoutes =
  (deps: KernelDeps): FastifyPluginAsyncZod =>
  (app) => {
    app.get(
      '/status/:slug',
      {
        // Every other route here resolves an actor first; this one never
        // does, which is the whole difference and is stated where it is made.
        schema: { params: z.object({ slug: z.string().min(1).max(64) }) },
      },
      async (req, reply) => {
        const page = await publicStatus(deps.db, req.params.slug, deps.now());
        if (!page) return await reply.code(404).type('text/html').send(MISSING);
        return await reply
          .code(200)
          .type('text/html')
          .header('cache-control', 'public, max-age=30')
          .header('x-content-type-options', 'nosniff')
          .header('referrer-policy', 'no-referrer')
          .header(
            'content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          )
          .send(render(page));
      },
    );
    return Promise.resolve();
  };

const MISSING = `<!doctype html><meta charset="utf-8"><title>Not found</title>
<body style="font:16px system-ui;margin:4rem auto;max-width:32rem"><p>There is no status page here.</p>`;

function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Plain HTML, no scripts and no requests anywhere: a status page has to
 * work when things are going badly, which is the only time anybody opens
 * one. Everything a visitor sees was written by whoever set the page up.
 */
function render(page: {
  title: string;
  apps: { label: string; up: boolean; percent: number }[];
}): string {
  const allUp = page.apps.every((a) => a.up);
  const headline =
    page.apps.length === 0
      ? 'Nothing is being watched yet'
      : allUp
        ? 'Everything is working'
        : 'Something is not working';
  const rows = page.apps
    .map(
      (app) => `<li>
      <span class="dot ${app.up ? 'up' : 'down'}" aria-hidden="true"></span>
      <span class="name">${escape(app.label)}</span>
      <span class="state">${app.up ? 'Working' : 'Not working'}</span>
      <span class="pct">${app.percent.toFixed(1)}% of the last 90 days</span>
    </li>`,
    )
    .join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)}</title>
<style>
  :root { color-scheme: light dark; --up: #128a3d; --down: #b4232b; --muted: #6b7280; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 42rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  p.headline { color: var(--muted); margin: 0 0 2rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: grid; grid-template-columns: auto 1fr auto; gap: .25rem .75rem; align-items: center;
       padding: .9rem 0; border-top: 1px solid rgba(128,128,128,.25); }
  .dot { width: .7rem; height: .7rem; border-radius: 50%; }
  .dot.up { background: var(--up); } .dot.down { background: var(--down); }
  .name { font-weight: 500; }
  .state { text-align: right; }
  .pct { grid-column: 2 / -1; color: var(--muted); font-size: .875rem; }
  footer { color: var(--muted); font-size: .8rem; margin-top: 2.5rem; }
</style>
<body>
  <h1>${escape(page.title)}</h1>
  <p class="headline">${headline}</p>
  <ul>${rows}</ul>
  <footer>Checked continuously. Times are in UTC.</footer>
`;
}
