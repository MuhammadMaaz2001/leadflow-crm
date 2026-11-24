import nodemailer, { type Transporter } from 'nodemailer';
import { afterCommit, db, prisma } from '../db';
import { config } from '../config';
import { enqueue } from './queue';
import { log } from './logger';

/**
 * Provider-independent email service with a transactional outbox.
 *
 *  sendEmail()   → inserts an `outbound_emails` row (QUEUED) inside the business transaction, then queues a job after commit.
 *  deliverEmail()→ the job: loads the row, hands it to the configured provider, records the true outcome.
 *  sweepEmailOutbox() → scheduler safety net: re-queues rows that were never delivered (Redis outage, crash between commit and enqueue).
 *
 * Providers (EMAIL_TRANSPORT):
 *   dev   — the database mailbox *is* the delivery (viewable at /dev/mailbox). Never allowed in production.
 *   smtp  — any SMTP server / provider (SES, Postmark, Mailgun, SendGrid SMTP, …) via nodemailer.
 *   none  — nothing is configured: mails are marked UNDELIVERABLE (never SENT) and a warning is logged.
 * A new provider only has to implement `EmailProvider`.
 */
export interface OutgoingEmail { to: string; subject: string; text: string; from: string }
export interface EmailProvider { name: string; send(msg: OutgoingEmail): Promise<{ messageId?: string }> }
export class EmailNotConfiguredError extends Error { constructor() { super('No email provider is configured (EMAIL_TRANSPORT=none)'); } }

const devProvider: EmailProvider = { name: 'dev', send: async () => ({ messageId: 'dev-mailbox' }) };
const noneProvider: EmailProvider = { name: 'none', send: async () => { throw new EmailNotConfiguredError(); } };

let smtp: Transporter | null = null;
const smtpProvider: EmailProvider = {
  name: 'smtp',
  async send(msg) {
    smtp ??= nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined, connectionTimeout: 10_000, socketTimeout: 20_000, requireTLS: !config.smtp.secure && config.isProd });
    const info = await smtp.sendMail({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text });
    return { messageId: info.messageId };
  },
};

let override: EmailProvider | null = null;
/** Tests (and future adapters) can inject a provider. */
export const setEmailProvider = (p: EmailProvider | null) => { override = p; };
export function getEmailProvider(): EmailProvider {
  if (override) return override;
  return config.emailTransport === 'smtp' ? smtpProvider : config.emailTransport === 'none' ? noneProvider : devProvider;
}
export const emailStatus = () => { const p = getEmailProvider(); return { provider: p.name, configured: p.name !== 'none', realDelivery: p.name !== 'dev' && p.name !== 'none' }; };

export async function sendEmail(input: { to: string; subject: string; body: string; link?: string }) {
  const row = await db().outboundEmail.create({ data: { toEmail: input.to.toLowerCase(), subject: input.subject, body: input.body, link: input.link, status: 'QUEUED' } });
  afterCommit(() => enqueue('email.send', { emailId: row.id }, { jobId: `email-${row.id}` }));
  return row.id;
}

/** Job body. Throws on transient failures so the queue retries with backoff; "not configured" is terminal (no retry storm). */
export async function deliverEmail(emailId: string) {
  const row = await prisma.outboundEmail.findUnique({ where: { id: emailId } });
  if (!row || row.status === 'SENT' || row.status === 'UNDELIVERABLE') return;
  const provider = getEmailProvider();
  const text = row.link ? `${row.body}\n\n${row.link}\n` : row.body;
  try {
    const r = await provider.send({ to: row.toEmail, subject: row.subject, text, from: config.emailFrom });
    // Production: do not keep one-time links at rest once the mail has been handed to the provider.
    const scrub = provider.name !== 'dev' ? { body: '[delivered]', link: null } : {};
    await prisma.outboundEmail.update({ where: { id: row.id }, data: { status: 'SENT', provider: provider.name, sentAt: new Date(), messageId: r.messageId ?? null, attempts: { increment: 1 }, lastError: null, ...scrub } });
    log.info('email sent', { emailId: row.id, provider: provider.name });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    if (e instanceof EmailNotConfiguredError) {
      await prisma.outboundEmail.update({ where: { id: row.id }, data: { status: 'UNDELIVERABLE', provider: provider.name, lastError: msg, attempts: { increment: 1 } } });
      log.warn('email NOT delivered: no provider configured', { emailId: row.id });
      return;
    }
    await prisma.outboundEmail.update({ where: { id: row.id }, data: { status: 'FAILED', provider: provider.name, lastError: msg, attempts: { increment: 1 } } });
    log.warn('email delivery failed', { emailId: row.id, provider: provider.name, error: msg });
    throw e;
  }
}

/** Re-queue rows that are still QUEUED / FAILED after 2 minutes (bounded to 100 per tick, at most 20 attempts). */
export async function sweepEmailOutbox(now = new Date()) {
  const stale = await prisma.outboundEmail.findMany({ where: { status: { in: ['QUEUED', 'FAILED'] }, attempts: { lt: 20 }, createdAt: { lt: new Date(now.getTime() - 120_000) } }, select: { id: true }, take: 100, orderBy: { createdAt: 'asc' } });
  for (const r of stale) await enqueue('email.send', { emailId: r.id }, { jobId: `email-${r.id}-sweep-${Math.floor(now.getTime() / 300_000)}` }).catch((e) => log.warn('email sweep enqueue failed', { error: (e as Error).message }));
  return stale.length;
}
