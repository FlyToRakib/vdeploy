import { sso } from '@better-auth/sso';
import { newId } from '@vdeploy/contracts';
import { member, type Database } from '@vdeploy/db';
import { and, eq } from 'drizzle-orm';

/**
 * Signing in through a company's own identity provider (§26 M6, ADR 0022).
 *
 * The protocol work — OIDC discovery, SAML signature and timestamp
 * validation, replay and InResponseTo checks — is Better Auth's. It is
 * not something to write by hand: a SAML assertion is a signed XML
 * document, and the interesting failures of every hand-rolled
 * implementation are signature wrapping and canonicalisation, which look
 * exactly like working code until somebody signs in as anybody.
 *
 * What VDeploy decides is everything around it: who may register a
 * provider (an org admin, through the gate), what an arriving person
 * becomes (a member of *that* organization, at the role the provider
 * says), and what happens to somebody the organization does not know.
 */

/** The role a person gets on their first sign-in through a provider. */
export const SSO_DEFAULT_ROLE = 'viewer';

export interface SsoDeps {
  db: Database;
}

export function ssoPlugin(deps: SsoDeps) {
  return sso({
    // Registering, updating and deleting a provider happen through
    // VDeploy's own operations, which run the policy engine and write the
    // audit log. The plugin's own endpoints for them are not reachable
    // (see routes/auth.ts); this cap is the second lock on the same door.
    providersLimit: 0,
    // A domain nobody has proved they own is a domain somebody else's
    // people could be sent to. Until the DNS record is there, the
    // provider exists and signs nobody in.
    domainVerification: { enabled: true, tokenPrefix: 'vdeploy-sso' },
    // Provider-asserted `email_verified` is the weak signal this used to
    // rest on; the domain check above is the strong one.
    trustEmailVerified: false,
    // VDeploy's roles are not Better Auth's two, and an organization is
    // never created by somebody signing in — they join one that exists.
    organizationProvisioning: { disabled: true },
    // Identity providers are where a person's name and email actually
    // live; when they change there, they change here.
    provisionUserOnEveryLogin: true,
    provisionUser: async ({ user, provider }) => {
      const orgId = (provider as { organizationId?: string | null }).organizationId;
      if (!orgId) return;
      const [already] = await deps.db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, user.id), eq(member.organizationId, orgId)));
      // Already a member: their role is VDeploy's to change, not the
      // identity provider's, so signing in never quietly re-grades them.
      if (already) return;
      await deps.db.insert(member).values({
        id: newId('member'),
        userId: user.id,
        organizationId: orgId,
        role: SSO_DEFAULT_ROLE,
      });
    },
  });
}
