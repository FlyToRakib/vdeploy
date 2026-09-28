import { OPERATIONS, toolName, type OperationDefinition } from '@vdeploy/contracts';
import { z } from 'zod';

/**
 * VDeploy as tools for somebody else's AI (§26 M6).
 *
 * It speaks MCP over stdin and stdout, which is what an AI client spawns
 * and talks to. Every tool is an operation from the catalog, and calling
 * one is an ordinary API call with the key this machine is signed in with
 * — the same route the dashboard, the CLI and VDeploy's own AI use, and
 * therefore the same plan, the same approval and the same audit entry
 * (§21). An outside model gets no path of its own; that is the point.
 *
 * Two rules the model cannot argue with, because they are not enforced
 * here:
 *
 *   - **Tier 4 is not offered.** An operation no key can call is left out
 *     of the tool list entirely — not described, not nameable. Opening a
 *     shell or reading a secret's value is for a person at a keyboard.
 *   - **Everything else is still gated server-side.** The tool list is a
 *     convenience; the key's scope, the person's role and the policy
 *     engine decide, and they decide again on every call.
 */

/** The JSON-RPC shapes this speaks, and nothing more. */
interface Request {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What an AI client is told it can do. */
export function tools(): Tool[] {
  return OPERATIONS.filter(offerable).map((operation) => ({
    name: toolName(operation),
    description: describe(operation),
    inputSchema: z.toJSONSchema(operation.input, { io: 'input', unrepresentable: 'any' }),
  }));
}

/**
 * Whether a tool is worth offering at all.
 *
 * A tool that can only ever be refused is worse than a missing one: the
 * model tries it, is told no, and tries again differently. Tier 4 is
 * refused for every key by the policy engine, so it is never offered.
 */
function offerable(operation: OperationDefinition): boolean {
  return operation.tier !== 'human_only';
}

/**
 * What the model is told about a tool.
 *
 * The risk tier is in the description on purpose. A model choosing between
 * two ways to do something should know which one can delete data, and a
 * person reading the transcript afterwards should be able to see that it
 * knew.
 */
function describe(operation: OperationDefinition): string {
  const parts = [operation.summary];
  if (operation.mutates) {
    parts.push(
      `Changes things (risk: ${operation.tier}).` +
        (operation.tier === 'destructive'
          ? ' Can lose data; a person may have to approve it before it runs.'
          : ' A person may have to approve it before it runs.'),
    );
  } else {
    parts.push('Reads only.');
  }
  return parts.join(' ');
}

export const PROTOCOL_VERSION = '2025-06-18';

export type Caller = (operation: string, input: unknown) => Promise<unknown>;

/**
 * Answers one request. Returns null for a notification, which by the
 * protocol gets no reply at all.
 */
export async function handle(request: Request, call: Caller): Promise<unknown> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0' as const, id: request.id ?? null, result });
  const error = (code: number, message: string) => ({
    jsonrpc: '2.0' as const,
    id: request.id ?? null,
    error: { code, message },
  });

  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vdeploy', version: '1' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: tools() });

    case 'tools/call': {
      // Whatever arrived, read as a name: a client that sends an object
      // here gets "there is no tool called …" rather than a crash.
      const asked = request.params?.name;
      const name = typeof asked === 'string' ? asked : '';
      const operation = OPERATIONS.find((o) => toolName(o) === name);
      if (!operation || !offerable(operation)) {
        // Said as a tool result rather than a protocol error, so the model
        // reads it and corrects itself instead of the client throwing.
        return reply(text(`There is no tool called ${name}.`, true));
      }
      try {
        const answer = await call(operation.name, request.params?.arguments ?? {});
        return reply(text(JSON.stringify(answer, null, 2)));
      } catch (err) {
        return reply(text(err instanceof Error ? err.message : String(err), true));
      }
    }

    default:
      return error(-32601, `${request.method} is not something this server does`);
  }
}

function text(body: string, isError = false) {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

/**
 * Reads requests from stdin and writes answers to stdout, one JSON object
 * per line.
 *
 * Nothing else may be written to stdout — a stray log line is a parse
 * error at the other end — so anything worth saying goes to stderr.
 */
export async function serve(input: NodeJS.ReadableStream, call: Caller): Promise<void> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'That was not JSON.' },
          }) + '\n',
        );
        continue;
      }
      const answer = await handle(request, call);
      if (answer !== null) process.stdout.write(JSON.stringify(answer) + '\n');
    }
  }
}
