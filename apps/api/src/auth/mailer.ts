import type { FastifyBaseLogger } from 'fastify';
import { createTransport } from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send: (mail: Mail) => Promise<void>;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  return {
    send: async (mail) => {
      await transport.sendMail({ from, ...mail });
    },
  };
}

/**
 * Used when no SMTP server is configured. Mail bodies carry single-use links
 * (password reset, sign-in alerts), so they are logged only in development.
 */
export function logMailer(logger: FastifyBaseLogger, development: boolean): Mailer {
  return {
    send: (mail) => {
      if (development) logger.info({ mail }, 'email (development: not sent)');
      else
        logger.warn({ to: mail.to, subject: mail.subject }, 'email not sent: SMTP_URL is not set');
      return Promise.resolve();
    },
  };
}

/** Collects mail in memory for tests. */
export function memoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    sent,
    send: (mail) => {
      sent.push(mail);
      return Promise.resolve();
    },
  };
}
