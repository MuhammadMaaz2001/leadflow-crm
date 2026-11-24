import { db } from '../db';
import { config } from '../config';

/**
 * Development email transport: persists every outgoing message to `outbound_emails`.
 * It is viewable at /dev/mailbox (disabled in production). A real SMTP provider would plug in here.
 */
if (config.isProd) console.warn('[email] EMAIL_TRANSPORT=dev stores messages in the database; configure a real email provider adapter before production use.');

export async function sendEmail(input: { to: string; subject: string; body: string; link?: string }) {
  await db().outboundEmail.create({ data: { toEmail: input.to.toLowerCase(), subject: input.subject, body: input.body, link: input.link } });
  if (!config.isTest) console.log(`[email:dev] to=${input.to} subject="${input.subject}" ${input.link ?? ''}`);
}
