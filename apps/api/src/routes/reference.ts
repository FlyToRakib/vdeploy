import { OPERATIONS, TIER_NUMBER, type OperationDefinition } from '@vdeploy/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * The public API, described (§26 M6).
 *
 * Every word of this is generated from the operation catalog, because the
 * catalog is what the API, the CLI, the AI tool registry and the dashboard
 * are all built from (§24). A reference written by hand is a reference
 * that is wrong the first time somebody adds an operation and does not
 * notice — and the thing people would trust it about is exactly the thing
 * it would be wrong about: which calls can delete their data.
 *
 * So there is nothing here to keep in step. Add an operation and it is
 * documented; change what it takes and the schema changes with it.
 */

/** What a caller needs to know about one operation, beyond its schema. */
function describe(operation: OperationDefinition): string {
  const lines = [operation.summary, ''];
  lines.push(
    operation.mutates
      ? `**Changes things.** Risk tier ${String(TIER_NUMBER[operation.tier])} (${operation.tier}).`
      : `**Reads only.** It returns ${operation.reads ?? 'nothing sensitive'}.`,
  );
  if (operation.tier === 'human_only') {
    lines.push(
      'No API key can call this, and neither can the AI: it is reserved for a ' +
        'signed-in person (§24 tier 4).',
    );
  }
  if (operation.stepUp) {
    lines.push('Needs the password again, even inside a valid session.');
  }
  lines.push(`Least role allowed: **${operation.minRole}**. Acts on: ${operation.scope}.`);
  if (operation.mutates) {
    lines.push(
      '',
      'Answers `200` with the outcome when it ran, or `202` with a plan that ' +
        'is waiting for somebody to approve it. Either way the body carries a ' +
        '`plan` you can follow at `/api/v1/plans/{id}`.',
    );
  }
  return lines.join('\n');
}

/**
 * The JSON Schema for one operation's input.
 *
 * Zod's own conversion is used rather than a hand-rolled walk: it is the
 * same schema the API validates against, so a caller reading this is
 * reading what will actually be enforced.
 */
function inputSchema(operation: OperationDefinition): unknown {
  try {
    return z.toJSONSchema(operation.input, { io: 'input', unrepresentable: 'any' });
  } catch {
    // A schema that cannot be drawn is still callable; saying so is better
    // than leaving the operation out of the reference entirely.
    return { type: 'object', description: 'See the operation’s own validation.' };
  }
}

export function openApiDocument(publicUrl: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const operation of OPERATIONS) {
    paths[`/api/v1/operations/${operation.name}`] = {
      post: {
        operationId: operation.name.replace('.', '_'),
        summary: operation.summary,
        description: describe(operation),
        tags: [operation.name.split('.')[0]],
        security: operation.tier === 'human_only' ? [] : [{ apiKey: [] }, { session: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['input'],
                properties: { input: inputSchema(operation) },
              },
            },
          },
        },
        responses: {
          200: { description: 'It ran. The body says what happened.' },
          202: { description: 'It needs approval first. The body carries the plan.' },
          400: { description: 'The request is not valid; the body says which field.' },
          403: { description: 'Refused by the policy engine; the body says why (§8).' },
          409: { description: 'It does not fit, or the world has moved since.' },
        },
      },
    };
  }

  paths['/api/v1/plans'] = {
    get: {
      operationId: 'plans_list',
      summary: 'List recent plans',
      description:
        'Every change goes through a plan, whether a person, the CLI or the ' +
        'AI asked for it (§4). This is the record.',
      tags: ['plans'],
      security: [{ apiKey: [] }, { session: [] }],
      parameters: [
        {
          in: 'query',
          name: 'status',
          schema: {
            type: 'string',
            enum: [
              'pending_approval',
              'approved',
              'applying',
              'applied',
              'failed',
              'rejected',
              'stale',
            ],
          },
        },
      ],
      responses: { 200: { description: 'The hundred most recent, newest first.' } },
    },
  };
  paths['/api/v1/plans/{id}'] = {
    get: {
      operationId: 'plans_get',
      summary: 'Follow one plan',
      description: 'What it will do, what it would put at risk, and where it has got to.',
      tags: ['plans'],
      security: [{ apiKey: [] }, { session: [] }],
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'The plan.' },
        404: { description: 'No such plan in this organization.' },
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'VDeploy',
      version: '1',
      description: [
        'One call per operation, and the same one whoever is asking (§21).',
        '',
        'The dashboard, the CLI, the MCP server and the AI all arrive at these',
        'routes. Nothing has a second way in, which is why the rules below hold',
        'for every caller: the same plan, the same approval, the same audit',
        'entry.',
        '',
        '## Authenticating',
        '',
        'Send an API key in an `x-api-key` header. Make one in the',
        'dashboard under Security, or with `api_key.create` while signed in.',
        'A key carries a scope — read-only keys cannot reach anything that',
        'changes.',
        '',
        '## What a call answers',
        '',
        'A change that ran answers `200`. A change that needs a person answers',
        '`202` and a plan waiting for approval — not an error, and not a',
        'failure: it is the platform telling you a human has to look. Follow it',
        'at `/api/v1/plans/{id}`.',
        '',
        '## What an API key cannot do',
        '',
        'Operations at tier 4 (`human_only`) are refused for every key and for',
        'the AI, whatever role it holds. Opening a shell, reading a secret',
        'value, removing a server: those are for a signed-in person at a',
        'keyboard.',
      ].join('\n'),
    },
    servers: [{ url: new URL(publicUrl).origin }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'An API key from the dashboard, under Security.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'vdeploy.session',
          description: 'A signed-in browser.',
        },
      },
    },
    paths,
  };
}

/**
 * The reference, served by the API that implements it.
 *
 * It is public and unauthenticated on purpose: what an API offers is not a
 * secret, and somebody deciding whether to use VDeploy should not have to
 * install it first. It describes the shape of every call; it grants none
 * of them.
 */
export const referenceRoutes =
  (publicUrl: string): FastifyPluginAsyncZod =>
  (app) => {
    const document = openApiDocument(publicUrl);
    app.get('/api/v1/openapi.json', () => document);
    /*
     * This one page is allowed to run its own script, read its own
     * stylesheet and fetch its own document — and nothing else, from
     * nowhere else.
     *
     * The API's own policy is `default-src 'none'`, which is right for
     * something that serves JSON and should never be a page at all. Rather
     * than loosen that for everything, the exception is written here, next
     * to the only thing that needs it, and it is still narrower than most
     * sites' baseline: no inline script, no inline style, no third party,
     * no frame, no form.
     */
    app.get('/api/v1/reference', (_req, reply) =>
      reply
        .header(
          'content-security-policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; " +
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .type('text/html; charset=utf-8')
        .send(REFERENCE_PAGE),
    );
    app.get('/api/v1/reference.css', (_req, reply) =>
      reply.type('text/css; charset=utf-8').send(REFERENCE_STYLE),
    );
    /*
     * The page's own script, as a file rather than inline.
     *
     * The Content-Security-Policy allows scripts from this origin and
     * refuses inline ones (§20), which is the right way round: a
     * reference page is not a reason to let any injected string run, and
     * the policy caught this when it was written the lazy way.
     */
    app.get('/api/v1/reference.js', (_req, reply) =>
      reply.type('text/javascript; charset=utf-8').send(REFERENCE_SCRIPT),
    );
    return Promise.resolve();
  };

/**
 * A page that renders the document above, with no build step and nothing
 * fetched from anywhere but this server: a reference that needs a CDN is a
 * reference that is blank on the day the CDN is blocked.
 */
const REFERENCE_STYLE = `:root { color-scheme: light dark; --edge: #8883; --muted: #7b7b85; --bg: Canvas; }
  body { margin: 0; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
  .wrap { max-width: 62rem; margin: 0 auto; padding: 2rem 1rem 6rem; }
  h1 { font-size: 1.8rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem; }
  .lede { color: var(--muted); margin: 0 0 2rem; }
  .op { border: 1px solid var(--edge); border-radius: .6rem; margin: .5rem 0; overflow: hidden; }
  .op > summary { cursor: pointer; padding: .6rem .8rem; display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .op > summary::marker { content: ''; }
  code { font-family: ui-monospace, monospace; }
  .name { font-family: ui-monospace, monospace; font-weight: 600; }
  .tier { font-size: .72rem; padding: .1rem .45rem; border-radius: 999px; border: 1px solid var(--edge); color: var(--muted); }
  .t4 { border-color: #d9534f88; color: #d9534f; }
  .t3 { border-color: #e0913088; color: #c97a1e; }
  .sum { color: var(--muted); flex: 1 1 14rem; }
  .body { padding: 0 .8rem .8rem; border-top: 1px solid var(--edge); }
  pre { background: #8881; padding: .7rem; border-radius: .4rem; overflow: auto; font-size: .82rem; }
  a { color: inherit; }
  .filter { width: 100%; padding: .6rem .7rem; border: 1px solid var(--edge); border-radius: .5rem; background: var(--bg); color: inherit; font: inherit; margin-bottom: 1rem; }`;

const REFERENCE_SCRIPT = `const doc = await (await fetch('/api/v1/openapi.json')).json();
document.getElementById('intro').innerHTML = doc.info.description
  .split('\\n\\n').map((p) => '<p>' + p.replace(/^## (.+)$/m, '</p><h2>$1</h2><p>')
  .replace(/\`([^\`]+)\`/g, '<code>$1</code>') + '</p>').join('');
const entries = Object.entries(doc.paths)
  .filter(([path]) => path.includes('/operations/'))
  .map(([path, item]) => ({ path, name: path.split('/operations/')[1], op: item.post }));
const tierOf = (text) => /tier 4/.test(text) ? 't4' : /tier 3/.test(text) ? 't3' : '';
const tierName = (text) => (text.match(/\\((safe|sensitive|destructive|human_only)\\)/) || [, 'read'])[1];
function render(needle) {
  const wanted = entries.filter(({ name, op }) =>
    !needle || name.includes(needle) || op.summary.toLowerCase().includes(needle));
  document.getElementById('ops').innerHTML = wanted.map(({ name, op }) => {
    const body = op.requestBody.content['application/json'].schema.properties.input;
    return '<details class="op"><summary>' +
      '<span class="name">' + name + '</span>' +
      '<span class="tier ' + tierOf(op.description) + '">' + tierName(op.description) + '</span>' +
      '<span class="sum">' + op.summary + '</span></summary>' +
      '<div class="body"><p>' + op.description.replace(/\\n/g, ' ')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>') + '</p>' +
      '<pre>' + JSON.stringify({ input: body }, null, 2) + '</pre></div></details>';
  }).join('') || '<p class="sum">Nothing matches that.</p>';
}
render('');
document.getElementById('filter').addEventListener('input', (e) =>
  render(e.target.value.trim().toLowerCase()));`;

const REFERENCE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VDeploy API</title>
<link rel="stylesheet" href="/api/v1/reference.css">
</head>
<body>
<div class="wrap">
  <h1>VDeploy API</h1>
  <p class="lede">One call per operation, and the same one whoever is asking. <a href="/api/v1/openapi.json">openapi.json</a></p>
  <div id="intro"></div>
  <h2>Operations</h2>
  <input id="filter" class="filter" placeholder="Filter by name or what it does" autocomplete="off">
  <div id="ops"></div>
</div>
<script type="module" src="/api/v1/reference.js"></script>
</body>
</html>
`;
