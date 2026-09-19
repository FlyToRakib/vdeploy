import { instanceSettings, invitation, type Database } from '@vdeploy/db';
import { APIError } from 'better-auth/api';
import { and, eq, gt } from 'drizzle-orm';

/**
 * Decides whether a new account may be created (§20.2 "closed by default").
 * The instance is set up once, by its owner; after that, invite-only unless
 * the owner deliberately opens or closes registration.
 */
export async function assertMayRegister(db: Database, email: string): Promise<void> {
  const [settings] = await db.select().from(instanceSettings).limit(1);
  if (!settings) {
    throw new APIError('FORBIDDEN', { message: 'This VDeploy instance has not been set up yet' });
  }
  if (settings.ownerUserId === null) return; // first-run setup is creating the owner
  if (settings.registration === 'open') return;
  if (settings.registration === 'invite') {
    const [pending] = await db
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          eq(invitation.email, email.toLowerCase()),
          eq(invitation.status, 'pending'),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (pending) return;
  }
  throw new APIError('FORBIDDEN', {
    message: 'Sign-up is by invitation only. Ask an administrator to invite you.',
  });
}
