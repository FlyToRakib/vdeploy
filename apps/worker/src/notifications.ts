import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { TRIGGER_LABELS, type NotificationPayload } from '@vdeploy/contracts';
import { isPublicAddress, signWebhook } from '@vdeploy/core';
import {
  claimDeliveries,
  deliveryFailed,
  deliverySent,
  openSigningSecret,
  type Database,
} from '@vdeploy/db';

export interface Mailer {
  send: (mail: { to: string; subject: string; text: string }) => Promise<void>;
}

/** Posts a webhook body; resolves to the HTTP status, rejects with a reason people can act on. */
export type WebhookPoster = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<number>;

export interface NotifierDeps {
  db: Database;
  secretsKey: Buffer;
  now: () => Date;
  /** Null when this VDeploy has no SMTP server: email channels fail with that reason. */
  mailer: Mailer | null;
  post: WebhookPoster;
  /** The dashboard's address, for links; null leaves them out. */
  publicUrl: string | null;
}

const TIMEOUT_MS = 10_000;

/**
 * Sends a webhook only to the public internet (unless this installation
 * allows private targets): every address the name resolves to is checked,
 * and the connection goes to the checked address, so a DNS answer that
 * changes between check and connect (rebinding) cannot redirect it.
 * Redirects are not followed.
 */
export function safePoster(allowPrivate: boolean): WebhookPoster {
  return async (url, body, headers) => {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true }).catch(() => {
          throw new Error(`${host} does not resolve`);
        });
    if (!allowPrivate) {
      const inside = addresses.find((a) => !isPublicAddress(a.address));
      if (inside) {
        throw new Error(
          `${host} points to a private address (${inside.address}); webhooks only go to the public internet`,
        );
      }
    }
    const pinned = addresses[0];
    if (!pinned) throw new Error(`${host} does not resolve`);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<number>((resolve, reject) => {
      const req = send(
        target,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
          timeout: TIMEOUT_MS,
          lookup: (_name, options, callback) => {
            if ((options as { all?: boolean }).all) {
              (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
                pinned,
              ]);
            } else {
              callback(null, pinned.address, pinned.family);
            }
          },
        },
        (res: IncomingMessage) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`no answer from ${host} within ${TIMEOUT_MS / 1000} seconds`));
      });
      req.on('error', (err) => {
        reject(err);
      });
      req.end(body);
    });
  };
}

function emailText(payload: NotificationPayload, channelName: string, link: string | null) {
  const why =
    payload.trigger === 'test'
      ? 'This is a test from VDeploy: the channel works.'
      : `You get this because "${channelName}" is set to tell you when: ${TRIGGER_LABELS[payload.trigger].toLowerCase()}.`;
  return [payload.message, link ? `\nOpen in VDeploy: ${link}` : '', `\n—\n${why}`].join('\n');
}

/** Sends every due notification once; failures are retried later with backoff. */
export async function sendDueNotifications(deps: NotifierDeps): Promise<number> {
  const due = await claimDeliveries(deps.db, deps.now());
  for (const { delivery, channel } of due) {
    const payload = delivery.payload;
    const link = payload.link && deps.publicUrl ? new URL(payload.link, deps.publicUrl).href : null;
    try {
      if (channel.config.kind === 'email') {
        if (!deps.mailer) throw new Error('email is not set up on this VDeploy (SMTP_URL)');
        for (const to of channel.config.to) {
          await deps.mailer.send({
            to,
            subject: `[VDeploy] ${payload.title}`,
            text: emailText(payload, channel.name, link),
          });
        }
      } else {
        const body = JSON.stringify({ ...payload, link });
        const secret = openSigningSecret(deps.secretsKey, channel);
        const unix = Math.floor(deps.now().getTime() / 1000);
        const status = await deps.post(channel.config.url, body, {
          'content-type': 'application/json',
          'user-agent': 'VDeploy-Webhook/1',
          'x-vdeploy-event': payload.trigger,
          'x-vdeploy-delivery': delivery.id,
          ...(secret ? { 'x-vdeploy-signature': signWebhook(secret, body, unix) } : {}),
        });
        if (status < 200 || status >= 300) throw new Error(`the webhook answered HTTP ${status}`);
      }
      await deliverySent(deps.db, delivery.id, deps.now());
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'could not send';
      await deliveryFailed(deps.db, delivery, reason, deps.now());
    }
  }
  return due.length;
}
