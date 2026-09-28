import { OPERATIONS, type OperationDefinition } from '@vdeploy/contracts';
import { z } from 'zod';

/**
 * Every operation, as a command (§26 M6).
 *
 * The catalog is already what the API, the reference and the AI tool
 * registry are built from (§24), so the CLI is built from it too rather
 * than keeping a second list that drifts. Add an operation and it has a
 * command, with its flags, its help and its risk tier, the same day.
 *
 * `project.list` is spelled `vdeploy project list`, because that is how
 * people say it. The dot form is accepted too — it is what the API calls
 * it, and somebody reading the reference should be able to paste it.
 */

export interface Flag {
  /** `--project-id`, from the field's name. */
  flag: string;
  field: string;
  required: boolean;
  /** What to turn the string on the command line into. */
  kind: 'string' | 'number' | 'boolean' | 'json';
  choices: string[] | null;
  describe: string | null;
}

export interface Command {
  /** `project list` — the words, in order. */
  words: string[];
  operation: OperationDefinition;
  flags: Flag[];
}

/** `projectId` → `--project-id`; the shape people expect on a command line. */
export function flagOf(field: string): string {
  return '--' + field.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** And back, because that is how the request is built. */
export function fieldOf(flag: string): string {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * What one operation takes, read off the schema the API validates against.
 *
 * Going through JSON Schema rather than poking at Zod's internals means
 * the flags are the fields that are really accepted: a schema that gains a
 * field gains a flag, and one that renames a field renames the flag.
 */
function flagsOf(operation: OperationDefinition): Flag[] {
  let schema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  try {
    schema = z.toJSONSchema(operation.input, {
      io: 'input',
      unrepresentable: 'any',
    }) as typeof schema;
  } catch {
    return [];
  }
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([field, spec]) => {
    const type = typeof spec.type === 'string' ? spec.type : null;
    const choices = Array.isArray(spec.enum) ? spec.enum.map(String) : null;
    return {
      flag: flagOf(field),
      field,
      required: required.has(field),
      // Anything that is not a plain scalar is given as JSON: a spec, a
      // list of domains, a set of rules. Pretending otherwise would mean
      // inventing a second syntax for things that already have one.
      kind:
        type === 'number' || type === 'integer'
          ? 'number'
          : type === 'boolean'
            ? 'boolean'
            : type === 'string'
              ? 'string'
              : 'json',
      choices,
      describe: typeof spec.description === 'string' ? spec.description : null,
    };
  });
}

export const COMMANDS: readonly Command[] = OPERATIONS.map((operation) => ({
  words: operation.name.split('.'),
  operation,
  flags: flagsOf(operation),
}));

/**
 * Finds the command somebody meant, by either spelling.
 *
 * Returns the words it consumed, so what is left is flags: the caller does
 * not have to know whether one word was used or two.
 */
export function findCommand(argv: readonly string[]): { command: Command; used: number } | null {
  const [first, second] = argv;
  if (first === undefined) return null;
  if (first.includes('.')) {
    const command = COMMANDS.find((c) => c.operation.name === first);
    return command ? { command, used: 1 } : null;
  }
  if (second !== undefined) {
    const command = COMMANDS.find((c) => c.words[0] === first && c.words[1] === second);
    if (command) return { command, used: 2 };
  }
  return null;
}

/** The nouns, for the top-level help: what a person can ask about. */
export function groups(): Map<string, Command[]> {
  const out = new Map<string, Command[]>();
  for (const command of COMMANDS) {
    const noun = command.words[0] ?? '';
    out.set(noun, [...(out.get(noun) ?? []), command]);
  }
  return out;
}
