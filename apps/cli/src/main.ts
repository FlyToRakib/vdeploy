#!/usr/bin/env node
import { COMMANDS, fieldOf, findCommand, groups, type Command } from './commands.js';
import { hint, readSettings, writeSettings } from './config.js';
import { serve } from './mcp.js';
import { bold, dim, renderPlan, renderResult } from './render.js';

/**
 * The VDeploy command line (§26 M6).
 *
 * It is the same platform from here as from the dashboard: the same
 * operation, the same plan, the same approval, the same audit entry (§21).
 * There is no faster path for a terminal, which is the point — a change
 * made from a script is a change somebody can find afterwards.
 */

const JSON_OUT = '--json';

function fail(message: string, code = 1): never {
  process.stderr.write(message + '\n');
  process.exit(code);
}

/** What a single flag expects, turned into what the API expects. */
function coerce(raw: string, command: Command, field: string): unknown {
  const flag = command.flags.find((f) => f.field === field);
  if (!flag) return raw;
  switch (flag.kind) {
    case 'number': {
      const value = Number(raw);
      if (Number.isNaN(value)) fail(`${flag.flag} wants a number, not "${raw}".`);
      return value;
    }
    case 'boolean':
      return raw !== 'false';
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        fail(
          `${flag.flag} wants JSON, and that is not valid JSON.\n` +
            `  Tip: read it from a file with ${flag.flag} "$(cat thing.json)".`,
        );
      }
    // eslint-disable-next-line no-fallthrough -- fail() never returns
    default:
      return raw;
  }
}

/**
 * Reads the flags off a command line.
 *
 * `--flag value` and `--flag=value` both work, and a boolean flag may be
 * given alone. An unknown flag is refused rather than ignored: silently
 * dropping `--replicas 3` because it was spelled `--replica` would deploy
 * the wrong thing and say it went fine.
 */
function parseFlags(argv: readonly string[], command: Command) {
  const input: Record<string, unknown> = {};
  let json = false;
  let watch = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === JSON_OUT) {
      json = true;
      continue;
    }
    if (token === '--watch') {
      watch = true;
      continue;
    }
    if (!token.startsWith('--')) fail(`I did not expect "${token}" here.`);
    const [name, inline] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];
    const field = fieldOf(name);
    const flag = command.flags.find((f) => f.field === field);
    if (!flag) {
      const near = command.flags
        .map((f) => f.flag)
        .filter((f) => f.startsWith(name.slice(0, 5)))
        .slice(0, 3);
      fail(
        `${command.operation.name} takes no ${name}.` +
          (near.length > 0 ? ` Did you mean ${near.join(' or ')}?` : '') +
          `\n  Its flags: ${command.flags.map((f) => f.flag).join(' ') || '(none)'}`,
      );
    }
    if (inline !== undefined) {
      input[field] = coerce(inline, command, field);
      continue;
    }
    const next = argv[i + 1];
    if (flag.kind === 'boolean' && (next === undefined || next.startsWith('--'))) {
      input[field] = true;
      continue;
    }
    if (next === undefined) fail(`${name} needs a value.`);
    input[field] = coerce(next, command, field);
    i++;
  }
  const missing = command.flags.filter((f) => f.required && !(f.field in input));
  if (missing.length > 0) {
    fail(
      `${command.operation.name} needs ${missing.map((f) => f.flag).join(' and ')}.\n` +
        `  ${command.operation.summary}`,
    );
  }
  return { input, json, watch };
}

function helpFor(command: Command): string {
  const { operation } = command;
  const lines = [
    bold(`vdeploy ${command.words.join(' ')}`),
    `  ${operation.summary}`,
    '',
    dim(
      `  ${operation.mutates ? `changes things · risk: ${operation.tier}` : 'reads only'} · ` +
        `least role: ${operation.minRole}`,
    ),
  ];
  if (operation.tier === 'human_only') {
    lines.push(dim('  No API key may call this: it is for a signed-in person at a keyboard.'));
  }
  if (command.flags.length > 0) {
    lines.push('', bold('  Flags'));
    const width = Math.max(...command.flags.map((f) => f.flag.length));
    for (const flag of command.flags) {
      const notes = [
        flag.required ? 'required' : null,
        flag.kind === 'json' ? 'JSON' : null,
        flag.choices ? flag.choices.join(' | ') : null,
        flag.describe,
      ].filter(Boolean);
      lines.push(`  ${flag.flag.padEnd(width)}  ${dim(notes.join(' · '))}`);
    }
  }
  return lines.join('\n');
}

function topHelp(): string {
  const lines = [
    bold('vdeploy') + ' — your servers, from here',
    '',
    '  vdeploy <thing> <do> [flags]      e.g. vdeploy project list',
    '  vdeploy <thing>                   what you can do to it',
    '  vdeploy login --url … --key …     point it at your VDeploy',
    '  vdeploy plan approve <id>         let a waiting change run',
    '  vdeploy mcp                       serve these as tools to an AI client',
    '',
    dim("  --json on any command for the API's own answer, unchanged."),
    '',
    bold('  Things'),
  ];
  const nouns = [...groups().keys()].sort();
  for (let i = 0; i < nouns.length; i += 6) {
    lines.push('  ' + nouns.slice(i, i + 6).join('  '));
  }
  return lines.join('\n');
}

async function call(path: string, body: unknown, method = 'POST'): Promise<unknown> {
  const settings = readSettings();
  if (!settings) {
    fail(
      'This machine is not signed in to a VDeploy yet.\n' +
        '  vdeploy login --url https://your-vdeploy --key <api key>\n' +
        '  Make a key in the dashboard, under Security.',
    );
  }
  let response: Response;
  try {
    response = await fetch(settings.url + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.key,
        'user-agent': 'vdeploy-cli',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    fail(
      `Could not reach ${settings.url}.\n  ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const problem = (parsed as { error?: { message?: string; code?: string } } | null)?.error;
    if (response.status === 401) {
      fail('That key was refused. Make a new one in the dashboard, then vdeploy login.', 3);
    }
    fail(problem?.message ?? `The control plane answered ${String(response.status)}.`, 3);
  }
  return parsed;
}

async function follow(planId: string): Promise<unknown> {
  // A change that is running is worth waiting for: the alternative is a
  // command that returns before anything has happened.
  for (let i = 0; i < 600; i++) {
    const plan = (await call(`/api/v1/plans/${planId}`, undefined, 'GET')) as {
      status: string;
    };
    if (['applied', 'failed', 'stale', 'rejected'].includes(plan.status)) return plan;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail('It is still running. Follow it in the dashboard.', 4);
}

async function main(argv: string[]) {
  const wantsJson = argv.includes(JSON_OUT);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(topHelp() + '\n');
    return;
  }

  if (argv[0] === 'login') {
    const url = argv[argv.indexOf('--url') + 1];
    const key = argv[argv.indexOf('--key') + 1];
    if (!argv.includes('--url') || !argv.includes('--key') || !url || !key) {
      fail('vdeploy login --url https://your-vdeploy --key <api key>');
    }
    // Checked before it is written: a key saved without being tried is a
    // key that fails on the next command instead of this one.
    const saved = writeSettings({ url: url.replace(/\/$/, ''), key });
    await call('/api/v1/operations/project.list', { input: {} });
    process.stdout.write(`Signed in to ${url}, key ${hint(key)}.\n${dim('  ' + saved)}\n`);
    return;
  }

  if (argv[0] === 'mcp') {
    /*
     * VDeploy as tools for somebody else's AI (§26 M6).
     *
     * It runs as this machine's signed-in user and calls the same routes
     * the dashboard does, so an outside model gets the same plan, the
     * same approval and the same audit entry — and no path of its own.
     *
     * stdout belongs to the protocol from here on: a stray line is a
     * parse error at the other end, so the greeting goes to stderr.
     */
    const settings = readSettings();
    if (!settings) {
      fail(
        'This machine is not signed in to a VDeploy yet.\n' +
          '  vdeploy login --url https://your-vdeploy --key <api key>',
      );
    }
    process.stderr.write(`vdeploy mcp · ${settings.url} · key ${hint(settings.key)}\n`);
    await serve(process.stdin, async (operation, input) => {
      const response = (await call(`/api/v1/operations/${operation}`, { input })) as {
        status: string;
        result?: unknown;
        plan?: unknown;
      };
      if (response.status === 'done') return response.result;
      // Said plainly, because the model has to tell the person rather
      // than assume it worked and carry on.
      return {
        waitingForApproval: response.status === 'pending_approval',
        plan: response.plan,
        note:
          response.status === 'pending_approval'
            ? 'This has NOT happened yet. A person must approve it in VDeploy.'
            : 'Accepted and running.',
      };
    });
    return;
  }

  if (argv[0] === 'whoami') {
    const settings = readSettings();
    if (!settings) fail('Not signed in.');
    process.stdout.write(`${settings.url}, key ${hint(settings.key)}\n`);
    return;
  }

  if (argv[0] === 'plan' && (argv[1] === 'approve' || argv[1] === 'reject')) {
    const id = argv[2];
    if (!id) fail(`vdeploy plan ${argv[1]} <plan id>`);
    const plan = await call(`/api/v1/plans/${id}/${argv[1]}`, {});
    process.stdout.write(
      (wantsJson ? JSON.stringify(plan, null, 2) : renderPlan(plan as never)) + '\n',
    );
    return;
  }

  const found = findCommand(argv);
  if (!found) {
    // One word that names a thing: show what can be done to it. It is the
    // question somebody actually has when they type `vdeploy project`.
    const noun = argv[0] ?? '';
    const family = groups().get(noun);
    if (family) {
      /*
       * Asking what can be done to a thing is a question, and it is
       * answered on stdout. Asking for something that does not exist is a
       * mistake: the same list is the way to fix it, but the command
       * failed, and a script that typed "levitate" must not be told it
       * worked.
       */
      const width = Math.max(...family.map((c) => c.words[1]?.length ?? 0));
      const listing = [
        bold(`vdeploy ${noun} …`),
        ...family.map((c) => `  ${(c.words[1] ?? '').padEnd(width)}  ${dim(c.operation.summary)}`),
      ].join('\n');
      if (argv.length === 1) {
        process.stdout.write(listing + '\n');
        return;
      }
      fail(`There is no "${argv.slice(0, 2).join(' ')}".\n` + listing);
    }
    fail(`I do not know "${argv.join(' ')}". Try: vdeploy help`);
  }

  const rest = argv.slice(found.used);
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(helpFor(found.command) + '\n');
    return;
  }

  const { input, json, watch } = parseFlags(rest, found.command);
  const response = (await call(`/api/v1/operations/${found.command.operation.name}`, {
    input,
  })) as { status: string; result?: unknown; plan?: { id: string } };

  if (json) {
    process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    // A change that is waiting is not a success, and a script should be
    // able to tell without reading prose.
    if (response.status === 'pending_approval') process.exitCode = 5;
    return;
  }

  if (response.status === 'done') {
    process.stdout.write(renderResult(response.result) + '\n');
    return;
  }

  const plan = response.plan;
  if (!plan) fail('The control plane answered something I do not understand.');
  if (watch && response.status === 'queued') {
    const settled = await follow(plan.id);
    process.stdout.write(renderPlan(settled as never) + '\n');
    return;
  }
  process.stdout.write(renderPlan(response.plan as never) + '\n');
  if (response.status === 'pending_approval') process.exitCode = 5;
}

void main(process.argv.slice(2)).catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});

export { COMMANDS };
