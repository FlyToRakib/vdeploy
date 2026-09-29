import type { Actor, ModelClient } from '@vdeploy/ai';
import type { GithubAppConfig, GithubOAuthConfig } from '@vdeploy/core';
import type { Database } from '@vdeploy/db';
import type { Auth } from '../auth/auth.js';
import type {
  ArtifactSource,
  FileSource,
  LogSource,
  ReclaimSource,
  TerminalSource,
} from '../agents/gateway.js';
import type { PortProbe } from '../agents/reachability.js';
import type { Mailer } from '../auth/mailer.js';
import type { AiCallWindow } from './ai-calls.js';

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
  /** Opens a shell in a project's container (§19); absent in tests. */
  terminals?: TerminalSource;
  /** Hands a backup or one of an app’s own files back from the server holding it. */
  artifacts?: ArtifactSource;
  /** Lists what is in an app’s permanent folders (§20 Runtime); absent in tests. */
  files?: FileSource;
  /** Frees disk on a server that is filling up (§18); absent in tests. */
  reclaim?: ReclaimSource;
  /** Whether a server's agent is on this connection right now; absent in tests. */
  connected?: (serverId: string) => boolean;
  /** Connects to a server's web ports from here; tests replace it. */
  probe: PortProbe;
  /** The VDeploy GitHub App, when this installation has one (M2 2.15). */
  github?: GithubDeps;
  /**
   * Reads the TXT records at a name, for proving a domain belongs to an
   * organization (§26 M6). Tests replace it; without one no domain can
   * be verified, which fails closed.
   */
  resolveTxt: (name: string) => Promise<string[]>;
  /** How this VDeploy reaches a Git host it was given; tests replace it. */
  fetch?: typeof fetch;
  /** The model behind the assistant; without one the assistant is off (§26).*/
  model?: ModelClient;
  /** Each AI session's calls in the last minute, for the rate limit (§8 L3). */
  aiCalls: AiCallWindow;
  /** The agent builds this control plane serves, per processor; absent without them. */
  agentBuilds?: () => Promise<Record<string, string> | null>;
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
