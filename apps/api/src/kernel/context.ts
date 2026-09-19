import type { HumanActor } from '@vdeploy/ai';
import type { Database } from '@vdeploy/db';
import type { Auth } from '../auth/auth.js';
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
  publicUrl: string;
  now: () => Date;
}

/** What an operation handler receives once the gate has let the request through. */
export interface HandlerContext {
  deps: KernelDeps;
  actor: HumanActor;
  args: Record<string, unknown>;
}

export type Handler = (context: HandlerContext) => Promise<unknown>;
