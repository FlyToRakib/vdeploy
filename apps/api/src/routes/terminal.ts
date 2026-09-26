import { VDeployError } from '@vdeploy/contracts';
import { closeTerminalSession, openTerminalSession, projects, recordTerminal } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';

/**
 * What the browser sends: keystrokes, and how big its window is. It comes
 * from a page, so it is checked like any other untrusted input rather than
 * trusted to be the shape it claims.
 */
const FromBrowser = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.base64().max(16_000) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);

/** How much of a person's typing is taken in one message. */
const MAX_INPUT_BYTES = 8192;

/**
 * The web terminal (§19, §20.1). It is human-only at every tier — the AI
 * cannot reach `terminal.open` however it is asked — and every session is
 * recorded, because a shell is the one place where what happened cannot be
 * reconstructed from a plan, a spec or a release.
 *
 * The browser sends keystrokes and a window size. It cannot name a
 * container, a command or a user: those are decided on the server, by the
 * agent, from state it already holds.
 */
export const terminalRoutes =
  (deps: KernelDeps): FastifyPluginAsync =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    app.get<{ Params: { projectId: string }; Querystring: { replica?: string } }>(
      '/api/v1/projects/:projectId/terminal',
      { websocket: true },
      (socket: WebSocket, req) => {
        void (async () => {
          const replica = Number(req.query.replica ?? '0');
          try {
            const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
            // The same gate as every other change: human-only, developer or
            // above, password again, and in the audit log before a key is hit.
            const allowed = await runOperation(deps, actor, 'terminal.open', {
              input: { projectId: req.params.projectId, replica },
            });
            if (allowed.status !== 'done') {
              throw new VDeployError('forbidden', 'This terminal cannot be opened');
            }
            const [project] = await deps.db
              .select({ id: projects.id, serverId: projects.serverId, orgId: projects.orgId })
              .from(projects)
              .where(eq(projects.id, req.params.projectId));
            if (!project?.serverId || project.orgId !== actor.orgId) {
              throw new VDeployError('not_found', 'Project not found');
            }
            if (!deps.terminals) {
              throw new VDeployError('unavailable', 'No server is connected to open it on');
            }
            const record = await deps.db.transaction((tx) =>
              openTerminalSession(
                tx,
                {
                  orgId: actor.orgId,
                  projectId: project.id,
                  serverId: project.serverId ?? '',
                  userId: actor.userId,
                  replica,
                },
                deps.now(),
              ),
            );
            attach(deps, socket, record.id, project.serverId, replica, req.params.projectId);
          } catch (error) {
            const message =
              error instanceof VDeployError ? error.message : 'This terminal could not be opened';
            socket.send(JSON.stringify({ type: 'end', reason: message }));
            socket.close(1008, 'refused');
          }
        })();
      },
    );
    return Promise.resolve();
  };

/** Joins a browser to a shell, and keeps the recording as they go. */
function attach(
  deps: KernelDeps,
  socket: WebSocket,
  sessionId: string,
  serverId: string,
  replica: number,
  projectId: string,
): void {
  let closed = false;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    void deps.db
      .transaction((tx) => closeTerminalSession(tx, sessionId, reason, deps.now()))
      .catch(() => undefined);
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'end', reason }));
      socket.close(1000, 'ended');
    }
  };
  /** Everything that crosses the session, in order, as it happens. */
  const keep = (chunk: string) => {
    void deps.db.transaction((tx) => recordTerminal(tx, sessionId, chunk)).catch(() => undefined);
  };

  const session = deps.terminals?.terminal(
    serverId,
    { sessionId, projectId, replica, cols: 80, rows: 24 },
    (data) => {
      keep(data.toString('utf8'));
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'output', data: data.toString('base64') }));
      }
    },
    finish,
  );
  if (!session) {
    finish('No server is connected to open it on');
    return;
  }

  socket.on('message', (raw: Buffer) => {
    const parsed = FromBrowser.safeParse(safeJson(raw));
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'resize') {
      session.resize(message.cols, message.rows);
      return;
    }
    const typed = Buffer.from(message.data, 'base64');
    if (typed.length === 0 || typed.length > MAX_INPUT_BYTES) return;
    keep(typed.toString('utf8'));
    session.send(typed);
  });
  socket.on('close', () => {
    session.close();
    finish('the person closed the terminal');
  });
}

/** Parses what a page sent, or nothing at all. */
function safeJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}
