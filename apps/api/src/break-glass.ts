import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { newId } from '@vdeploy/contracts';
import {
  account,
  appendAudit,
  connect,
  member,
  organization,
  session,
  twoFactor,
  user,
  type Database,
} from '@vdeploy/db';
import { and, eq, inArray } from 'drizzle-orm';
import { hashPassword } from './auth/password.js';

/**
 * The way back in for whoever holds the machine (§30 ⑧).
 *
 * Recovery codes cover a lost authenticator; nothing in the dashboard can
 * cover a lost password *and* a lost authenticator, because anything the
 * dashboard could do, an attacker at the sign-in page could try. The
 * person who can open a shell on the control-plane host already holds
 * every key there is, so this asks for nothing more than that:
 *
 *   docker compose -f deploy/compose.yml exec api node /app/api/dist/break-glass.js who
 *   docker compose -f deploy/compose.yml exec api node /app/api/dist/break-glass.js reset owner@example.com
 *
 * `reset` makes up the new password rather than asking for one, so it is
 * never typed where a shell history or a process list could keep it. It
 * turns two-factor sign-in off and signs every session out, and the audit
 * log records that it happened — never the password.
 */
export async function breakGlass(db: Database, args: string[], say: (line: string) => void) {
  const [command, email] = args;
  if (command === 'who') {
    const rows = await db
      .select({ email: user.email, role: member.role, organization: organization.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(inArray(member.role, ['owner', 'admin']));
    if (rows.length === 0) say('Nobody administers an organization here yet.');
    for (const row of rows) say(`${row.email}\t${row.role}\t${row.organization}`);
    return 0;
  }
  if (command === 'reset' && email) {
    const [person] = await db.select().from(user).where(eq(user.email, email.toLowerCase()));
    if (!person) {
      say(`Nobody here signs in as ${email}. "who" lists the people who can.`);
      return 1;
    }
    // Four groups of six from an alphabet with nothing to misread.
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(24);
    const password = Array.from(bytes, (b) => alphabet[b % alphabet.length])
      .join('')
      .replace(/(.{6})(?!$)/g, '$1-');
    const hashed = await hashPassword(password);
    await db.transaction(async (tx) => {
      const [credential] = await tx
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, person.id), eq(account.providerId, 'credential')));
      if (credential) {
        await tx.update(account).set({ password: hashed }).where(eq(account.id, credential.id));
      } else {
        // Somebody who only ever used a passkey gets a password to come back with.
        await tx.insert(account).values({
          id: newId('account'),
          accountId: person.id,
          providerId: 'credential',
          userId: person.id,
          password: hashed,
        });
      }
      await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, person.id));
      await tx.delete(twoFactor).where(eq(twoFactor.userId, person.id));
      await tx.delete(session).where(eq(session.userId, person.id));
      await appendAudit(tx, {
        chain: '',
        actor: { system: 'break-glass' },
        action: 'auth.break_glass',
        target: person.id,
        outcome: 'succeeded',
        details: { email: person.email },
      });
    });
    say(`${person.email} can sign in with this password, once:`);
    say('');
    say(`    ${password}`);
    say('');
    say('Two-factor sign-in is off and every session is signed out. After signing in,');
    say('change the password and turn two-factor back on, under Security.');
    return 0;
  }
  say('Usage: break-glass who | break-glass reset <email>');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set: run this inside the api container.');
    process.exit(2);
  }
  const { db, close } = connect(url, { max: 1 });
  const code = await breakGlass(db, process.argv.slice(2), (line) => {
    console.log(line);
  }).finally(close);
  process.exit(code);
}
