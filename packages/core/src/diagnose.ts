import type { Diagnosis, ReplicaEvidence } from '@vdeploy/contracts';

/**
 * The plain-language layer (§32): deterministic rules that turn what the
 * agent saw into the cause, in words a non-coder can act on, with the fix
 * and what it risks. No model is called; the AI only adds nuance on top.
 * Rule 1: name the cause, never the symptom.
 */

export interface DiagnosisInput {
  /** The port the platform sends traffic to. */
  containerPort: number | null;
  /** Memory limit, as written in the spec (512Mi). */
  memoryLimit: string;
  evidence: ReplicaEvidence[];
}

const RUNNING = new Set(['running', 'ready', 'starting', 'unhealthy']);
const LOCALHOST = /^(127\.\d+\.\d+\.\d+|::1|\[::1\])$/;
const ANY = /^(0\.0\.0\.0|::|\[::\])$/;

function split(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(':');
  return { host: address.slice(0, at), port: Number(address.slice(at + 1)) };
}

/** Patterns in an app's last output that name a cause (checked in order). */
const OUTPUT_RULES: {
  condition: string;
  pattern: RegExp;
  plain: (m: RegExpMatchArray) => string;
  fix: (m: RegExpMatchArray) => string;
}[] = [
  {
    condition: 'missing_env_var',
    pattern:
      /(?:environment variable|env(?:ironment)? var(?:iable)?)\s+["'`]?([A-Z][A-Z0-9_]{1,})["'`]?\s+(?:is\s+)?(?:not set|missing|required|undefined)|Missing (?:required )?(?:environment variable|env(?: var)?)[:\s]+["'`]?([A-Z][A-Z0-9_]{1,})|KeyError: ['"]([A-Z][A-Z0-9_]{1,})['"]/i,
    plain: (m) =>
      `Your app stops because it needs a setting called ${m[1] ?? m[2] ?? m[3]} that it was not given.`,
    fix: (m) =>
      `Add ${m[1] ?? m[2] ?? m[3]} to the app's environment variables, then deploy again.`,
  },
  {
    condition: 'database_unreachable',
    pattern:
      /ECONNREFUSED[^\n]*:(5432|3306|6379|27017)|could not connect to server|Connection refused[^\n]*(5432|3306)|getaddrinfo ENOTFOUND[^\n]*(db|postgres|mysql|redis)/i,
    plain: () => 'Your app stops because it cannot reach its database.',
    fix: () =>
      "Check the database address in the app's settings (DATABASE_URL or similar), and that the database is running.",
  },
  {
    condition: 'port_in_use',
    pattern: /EADDRINUSE|address already in use/i,
    plain: () => 'Your app tries to use a port something else inside its container already holds.',
    fix: () => 'Start only one server process in the app, or give the second one a different port.',
  },
  {
    condition: 'module_not_found',
    pattern:
      /Cannot find module ['"]([^'"]+)['"]|Module not found: (?:Error: )?Can't resolve ['"]([^'"]+)['"]|ModuleNotFoundError: No module named ['"]([^'"]+)['"]/,
    plain: (m) =>
      `Your app cannot find ${m[1] ?? m[2] ?? m[3]}. On a server, file names are case-sensitive: ./Header and ./header are different files, even though your computer treats them the same.`,
    fix: (m) =>
      `Check that the name ${m[1] ?? m[2] ?? m[3]} matches the file or package exactly, including capital letters, and that it is listed in your dependencies.`,
  },
  {
    condition: 'runtime_version',
    pattern:
      /requires? (?:Node(?:\.js)?|node) (?:version )?[>=^~ ]*v?(\d+)|The engine "node" is incompatible|SyntaxError: Unexpected token '\?\?=?'|Python (\d\.\d+) or (?:newer|later) is required/i,
    plain: (m) =>
      m[1]
        ? `Your app needs a newer version of its language runtime (version ${m[1]} or later).`
        : 'Your app needs a newer version of its language runtime than the one it was built with.',
    fix: () =>
      'Set the version in your project (the "engines" field in package.json, or .python-version / .node-version), then deploy again.',
  },
];

/** What the agent's evidence says about why the app is not serving. */
export function diagnose(input: DiagnosisInput): Diagnosis[] {
  const found: Diagnosis[] = [];
  const add = (d: Diagnosis) => {
    if (!found.some((f) => f.condition === d.condition)) found.push(d);
  };
  for (const replica of input.evidence) {
    if (replica.oomKilled) {
      add({
        condition: 'out_of_memory',
        detected: `the kernel stopped the app for using more than its ${input.memoryLimit} memory limit`,
        plain: `Your app ran out of memory: it needed more than the ${input.memoryLimit} it is allowed, so it was stopped.`,
        fix: 'Raise the memory limit, or find what in the app uses so much memory.',
        confidence: 'high',
        risk: 'none — your app is already stopping',
      });
      continue;
    }
    // Running states from the agent: ready, starting, unhealthy (up but failing its check).
    const exited = !RUNNING.has(replica.state) || replica.exitCode !== null;
    if (exited || replica.restarts >= 3) {
      const output = replica.lastOutput;
      const rule = OUTPUT_RULES.map((r) => ({ r, m: output.match(r.pattern) })).find((x) => x.m);
      if (rule?.m) {
        add({
          condition: rule.r.condition,
          detected: `the app stopped (exit ${replica.exitCode ?? '?'}) and its last output matches a known cause`,
          plain: rule.r.plain(rule.m),
          fix: rule.r.fix(rule.m),
          confidence: 'high',
          risk: 'none — your app is already stopping',
        });
      } else {
        const tail = output.trim().split('\n').slice(-3).join(' ⏎ ').slice(0, 400);
        add({
          condition: 'crash_loop',
          detected: `the app stopped with exit code ${replica.exitCode ?? '?'} after ${replica.restarts} restarts`,
          plain: `Your app keeps stopping right after it starts. The last thing it said was: ${tail || '(nothing)'}`,
          fix: 'That last message usually names what is wrong; fix it in the app and deploy again.',
          confidence: 'medium',
          risk: 'none — your app is already stopping',
        });
      }
      continue;
    }
    if (input.containerPort === null || replica.listening === null) continue;
    const port = input.containerPort;
    const sockets = replica.listening.map(split);
    const onPort = sockets.filter((s) => s.port === port);
    if (onPort.length > 0 && onPort.every((s) => LOCALHOST.test(s.host))) {
      add({
        condition: 'listening_on_localhost',
        detected: `the app listens on ${onPort.map((s) => `${s.host}:${s.port}`).join(', ')} only`,
        plain:
          "Your app is running, but it's only accepting connections from inside its own container. It needs to listen on 0.0.0.0 instead of localhost — otherwise nothing can reach it.",
        fix: 'In your code, change the server host from localhost (127.0.0.1) to 0.0.0.0.',
        confidence: 'high',
        risk: 'none — your site is already down',
      });
      continue;
    }
    if (onPort.length === 0) {
      const other = sockets.find((s) => ANY.test(s.host) || !LOCALHOST.test(s.host));
      if (other) {
        add({
          condition: 'wrong_port',
          detected: `the app listens on port ${other.port}; traffic is sent to port ${port}`,
          plain: `Your app answers on port ${other.port}, but we're knocking on port ${port}.`,
          fix: `Change the app's port setting to ${other.port}; your site comes back once it redeploys, and nothing is lost.`,
          confidence: 'high',
          risk: 'none — your site is already down',
          proposal: { containerPort: other.port },
        });
      } else {
        add({
          condition: 'not_listening',
          detected: `the app is running but nothing listens on port ${port}`,
          plain: `Your app is running, but it is not accepting connections on port ${port} yet.`,
          fix: `Make the app listen on 0.0.0.0:${port} (many frameworks read the PORT variable), or give it longer to start if it is slow.`,
          confidence: 'medium',
          risk: 'none — your site is already down',
        });
      }
    }
  }
  return found;
}

/** Build-log patterns (§30 ④): the build failed, and why, in plain words. */
export function diagnoseBuild(log: string): Diagnosis | null {
  const rules: { condition: string; pattern: RegExp; plain: string; fix: string }[] = [
    {
      condition: 'build_missing_script',
      pattern: /npm ERR! Missing script: "?(\w+)"?|Missing script: "(\w+)"/,
      plain: 'The build asks your app to run a script it does not have.',
      fix: 'Add the script to package.json ("build" or "start"), or pick the right folder to build from.',
    },
    {
      condition: 'build_module_not_found',
      pattern:
        /Module not found: (?:Error: )?Can't resolve ['"]([^'"]+)['"]|Cannot find module ['"]([^'"]+)['"]/,
      plain:
        'The build cannot find a file your code imports. On a server, file names are case-sensitive, even when your computer ignores case.',
      fix: 'Make every import match the file name exactly, including capital letters.',
    },
    {
      condition: 'build_out_of_memory',
      pattern: /JavaScript heap out of memory|Killed\s*$|exit code: 137/m,
      plain: 'The build ran out of memory.',
      fix: 'Raise the build memory limit in the agent settings, or build on a bigger server.',
    },
    {
      condition: 'build_dependency_install',
      pattern:
        /npm ERR! code (ERESOLVE|E404)|No matching distribution found for|Could not find a version that satisfies/,
      plain: 'The build could not install one of your dependencies.',
      fix: 'Check the dependency names and versions in your package file; a lock file helps.',
    },
  ];
  for (const r of rules) {
    if (r.pattern.test(log)) {
      return {
        condition: r.condition,
        detected: 'a known pattern in the build log',
        plain: r.plain,
        fix: r.fix,
        confidence: 'high',
        risk: 'none — nothing was deployed',
      };
    }
  }
  return null;
}
