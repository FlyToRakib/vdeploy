import type { Actor, ModelClient } from '@vdeploy/ai';
import type { GithubAppConfig, GithubOAuthConfig } from '@vdeploy/core';
import type { Database } from '@vdeploy/db';
import type { Auth } from '../auth/auth.js';
import type { ArtifactSource, LogSource } from '../agents/gateway.js';
import type { PortProbe } from '../agents/reachability.js';
import type { Mailer } from '../auth/mailer.js';

/** Hands an approved plan to the worker that applies it. */
export interface ApplyQueue {
  enqueue: (planId: string) => Promise<void>;
}

/** Everything the kernel needs, passed explicitly — no globals. */
export interface KernelDeps {
  db: Database;
  auth: Auth;
  mailer: Mailer;
  queue: ApplyQueue;
  approvalKey: Buffer;
  /** The installation key that wraps each project's secret key. */
  secretsKey: Buffer;
  publicUrl: string;
  now: () => Date;
  /** Live container output, through the agent channel; absent in tests without agents. */
  logs?: LogSource;
  /** Hands a backup file back from the server holding it (§17.5). */
  artifacts?: ArtifactSource;
  /** Whether a server's agent is on this connection right now; absent in tests. */
  connected?: (serverId: string) => boolean;
  /** Connects to a server's web ports from here; tests replace it. */
  probe: PortProbe;
  /** The VDeploy GitHub App, when this installation has one (M2 2.15). */
  github?: GithubDeps;
  /** The model behind the assistant; without one the assistant is off (§26).*/
  model?: ModelClient;
}

export interface GithubDeps {
  app: GithubAppConfig & GithubOAuthConfig;
  /** The app's URL name: github.com/apps/<slug>. */
  slug: string;
  /** GitHub signs every webhook with it. */
  webhookSecret: string;
}

/** What an operation handler receives once the gate has let the request through. */
export interface HandlerContext {
  deps: KernelDeps;
  actor: Actor;
  args: Record<string, unknown>;
}

export type Handler = (context: HandlerContext) => Promise<unknown>;
