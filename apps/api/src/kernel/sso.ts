import { discoverOIDCConfig } from '@better-auth/sso';
import { newId, SsoSettings, VDeployError, type OperationName } from '@vdeploy/contracts';
import { fetchableOrigin } from '@vdeploy/core';
import { ssoProvider } from '@vdeploy/db';
import { and, asc, eq } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * Connecting a company's own identity provider (§26 M6, ADR 0022).
 *
 * The split here is the decision worth reading. Better Auth's SSO plugin
 * owns the **protocol**: OIDC discovery, SAML signature, timestamp,
 * audience and replay validation — none of which should be written by
 * hand, because the interesting failures of a hand-rolled SAML verifier
 * are signature wrapping and canonicalisation, and they look exactly
 * like working code until somebody signs in as anybody.
 *
 * VDeploy owns the **authorization and the row**. The plugin's own
 * registration endpoint takes an `organizationId` in its body and is not
 * reachable (see routes/auth.ts, and `providersLimit: 0` beside it);
 * these handlers write the row with the organization taken from the
 * session, so no request can name somebody else's.
 */

/** A stable name for the provider, so a callback URL never moves. */
export function providerIdFor(orgId: string, domain: string): string {
  return `${orgId.toLowerCase()}-${domain.replace(/[^a-z0-9]+/g, '-')}`;
}

/** What goes in the row, in the shape the plugin reads back at sign-in. */
async function configFor(domain: string, settings: SsoSettings) {
  if (settings.protocol === 'oidc') {
    // Asked now rather than at somebody's first sign-in: a typo in the
    // address should be a sentence on this screen, not an error on a
    // Monday morning for a person who cannot fix it.
    //
    // A console shows both the issuer and the well-known address, and
    // people paste whichever they are looking at. The issuer is the one
    // the document has to agree with, so the other is trimmed back to it.
    const issuer = settings.issuer.replace(/\/?\.well-known\/openid-configuration\/?$/, '');
    if (!fetchableOrigin(issuer)) {
      throw new VDeployError(
        'invalid_input',
        'That address is not one this VDeploy will fetch from: it must be https, and not an address inside this machine or its network.',
      );
    }
    const discovered = await discoverOIDCConfig({
      issuer,
      // The endpoints a discovery document names are fetched too, so the
      // same rule applies to each of them.
      isTrustedOrigin: fetchableOrigin,
    }).catch((error: unknown) => {
      throw new VDeployError(
        'invalid_input',
        `That address did not answer as an OpenID provider: ${error instanceof Error ? error.message : 'it could not be read'}`,
      );
    });
    return {
      issuer: discovered.issuer,
      oidcConfig: JSON.stringify({
        ...discovered,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        scopes: settings.scopes,
        pkce: true,
      }),
      samlConfig: null,
    };
  }
  return {
    issuer: settings.entityId,
    oidcConfig: null,
    samlConfig: JSON.stringify({
      entryPoint: settings.entryPoint,
      ...(settings.certificate ? { cert: settings.certificate } : {}),
      audience: settings.entityId,
      idpMetadata: {
        entityID: settings.entityId,
        ...(settings.metadataXml ? { metadata: settings.metadataXml } : {}),
        ...(settings.certificate ? { cert: settings.certificate } : {}),
      },
      wantAssertionsSigned: true,
    }),
  };
}

const view = (row: typeof ssoProvider.$inferSelect) => ({
  providerId: row.providerId,
  protocol: row.samlConfig ? ('saml' as const) : ('oidc' as const),
  issuer: row.issuer,
  domain: row.domain,
  domainVerified: row.domainVerified,
  createdAt: row.createdAt.toISOString(),
});

export const SSO_ADMIN: Partial<Record<OperationName, Handler>> = {
  'sso.connect': async ({ deps, actor, args }) => {
    const domain = String(args.domain).toLowerCase();
    const settings = SsoSettings.parse(args.settings);
    const providerId = providerIdFor(actor.orgId, domain);
    // A domain belongs to one organization here. Two claiming it would
    // mean one of them decides where the other's people sign in.
    const [taken] = await deps.db
      .select({ organizationId: ssoProvider.organizationId })
      .from(ssoProvider)
      .where(eq(ssoProvider.domain, domain));
    if (taken && taken.organizationId !== actor.orgId) {
      throw new VDeployError(
        'conflict',
        `${domain} is already connected to another organization on this VDeploy.`,
      );
    }
    const config = await configFor(domain, settings);
    const [row] = await deps.db
      .insert(ssoProvider)
      .values({
        id: newId('ssoProvider'),
        providerId,
        organizationId: actor.orgId,
        userId: actor.userId,
        domain,
        ...config,
      })
      .onConflictDoUpdate({
        target: ssoProvider.providerId,
        set: {
          ...config,
          // Changing where people are sent is changing who can get in, so
          // the domain has to be proved again from here.
          domainVerified: false,
          updatedAt: deps.now(),
        },
      })
      .returning();
    if (!row) throw new VDeployError('internal', 'The provider could not be saved');
    return {
      ...view(row),
      verifyBy: {
        type: 'TXT',
        record: `_vdeploy-sso.${domain}`,
        value: `vdeploy-sso-verification=${providerId}`,
      },
      then: 'Add that DNS record, then check it here. Nobody signs in through this provider until it is there.',
    };
  },
  'sso.verify_domain': async ({ deps, actor, args }) => {
    const providerId = String(args.providerId);
    const [row] = await deps.db
      .select()
      .from(ssoProvider)
      .where(
        and(eq(ssoProvider.providerId, providerId), eq(ssoProvider.organizationId, actor.orgId)),
      );
    if (!row) throw new VDeployError('not_found', 'That identity provider is not here');
    const wanted = `vdeploy-sso-verification=${providerId}`;
    const records = await deps.resolveTxt(`_vdeploy-sso.${row.domain}`);
    if (!records.some((value) => value.trim() === wanted)) {
      throw new VDeployError(
        'conflict',
        `The TXT record at _vdeploy-sso.${row.domain} is not there yet, or does not say ${wanted}. DNS can take a few minutes.`,
      );
    }
    const [verified] = await deps.db
      .update(ssoProvider)
      .set({ domainVerified: true, updatedAt: deps.now() })
      .where(eq(ssoProvider.providerId, providerId))
      .returning();
    return view(verified ?? row);
  },
  'sso.disconnect': async ({ deps, actor, args }) => {
    const removed = await deps.db
      .delete(ssoProvider)
      .where(
        and(
          eq(ssoProvider.providerId, String(args.providerId)),
          eq(ssoProvider.organizationId, actor.orgId),
        ),
      )
      .returning({ providerId: ssoProvider.providerId });
    if (removed.length === 0) {
      throw new VDeployError('not_found', 'That identity provider is not here');
    }
    // People who signed in through it keep their sessions and their
    // membership: taking a door away is not taking the room away.
    return { disconnected: true };
  },
};

export const SSO_QUERIES: Partial<Record<OperationName, Handler>> = {
  'sso.list': async ({ deps, actor }) => {
    const rows = await deps.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, actor.orgId))
      .orderBy(asc(ssoProvider.domain));
    return rows.map(view);
  },
};
