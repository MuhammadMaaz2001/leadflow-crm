import type { Response } from 'express';
import {
  changePasswordSchema, forgotSchema, loginSchema, profileSchema, registerSchema, resetSchema,
} from '@leadflow/shared';
import { z } from 'zod';
import { config } from '../../config';
import { db, prisma } from '../../db';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto';
import { sendEmail } from '../../lib/email';
import { defineRoutes, resolveSession } from '../../http';

export const auth = defineRoutes('Authentication', '/auth');

function setSessionCookie(res: Response, token: string) {
  res.cookie(config.cookieName, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: config.sessionTtlDays * 86_400_000,
  });
}

async function issueVerification(userId: string, email: string) {
  const token = randomToken();
  await db().authToken.create({ data: { userId, type: 'EMAIL_VERIFY', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86_400_000) } });
  const link = `${config.webUrl}/verify-email?token=${token}`;
  await sendEmail({ to: email, subject: 'Verify your LeadFlow account', body: 'Welcome to LeadFlow! Confirm your email address to activate your account.', link });
  return link;
}

export async function workspacesFor(userId: string) {
  const rows = await db().membership.findMany({
    where: { userId },
    include: { organization: { include: { subscription: { include: { plan: true } } } }, role: true },
    orderBy: { joinedAt: 'asc' },
  });
  return rows.map((m) => ({
    membershipId: m.id, status: m.status,
    organization: {
      id: m.organization.id, name: m.organization.name, slug: m.organization.slug, logoData: m.organization.logoData, status: m.organization.status,
      onboardingCompleted: !!m.organization.onboardingCompletedAt, currency: m.organization.currency, timezone: m.organization.timezone,
    },
    role: { id: m.role.id, name: m.role.name, key: m.role.systemKey, permissions: m.role.permissions },
    subscription: m.organization.subscription ? { status: m.organization.subscription.status, planCode: m.organization.subscription.plan.code, planName: m.organization.subscription.plan.name, trialEndsAt: m.organization.subscription.trialEndsAt } : null,
  }));
}

async function mePayload(userId: string) {
  const u = await db().user.findUniqueOrThrow({ where: { id: userId } });
  return {
    user: { id: u.id, email: u.email, name: u.name, phone: u.phone, jobTitle: u.jobTitle, emailVerified: !!u.emailVerifiedAt, platformRole: u.platformRole, createdAt: u.createdAt },
    workspaces: await workspacesFor(userId),
  };
}

auth.post('/register', { auth: 'public', body: registerSchema.extend({ inviteToken: z.string().optional() }), summary: 'Register a new user account' }, async ({ body, res }) => {
  const existing = await db().user.findUnique({ where: { email: body.email } });
  if (existing) throw conflict('An account with this email already exists. Try signing in.', undefined, 'EMAIL_TAKEN');
  const user = await db().user.create({ data: { email: body.email, name: body.name, passwordHash: await hashPassword(body.password) } });
  // An invitation sent to this exact address already proves control of the mailbox.
  let verifiedViaInvite = false;
  if (body.inviteToken) {
    const [prev] = await db().$queryRaw<{ email: string; status: string }[]>`SELECT email, status::text FROM invitation_preview(${sha256(body.inviteToken)})`;
    if (prev && prev.email.toLowerCase() === body.email && prev.status === 'PENDING') {
      await db().user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      verifiedViaInvite = true;
    }
  }
  const link = verifiedViaInvite ? null : await issueVerification(user.id, user.email);
  res.status(201);
  return { id: user.id, email: user.email, verificationRequired: !verifiedViaInvite, ...(config.isProd ? {} : { devVerificationLink: link, devNote: 'Development only: in production this link is delivered by email.' }) };
});

auth.post('/verify-email', { auth: 'public', body: z.object({ token: z.string().min(10) }), summary: 'Confirm an email address' }, async ({ body }) => {
  const t = await db().authToken.findUnique({ where: { tokenHash: sha256(body.token) } });
  if (!t || t.type !== 'EMAIL_VERIFY' || t.usedAt || t.expiresAt < new Date()) throw badRequest('This verification link is invalid or has expired.', undefined, 'INVALID_TOKEN');
  await db().authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  await db().user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
  return { verified: true };
});

auth.post('/resend-verification', { auth: 'public', body: forgotSchema, summary: 'Resend the verification email' }, async ({ body }) => {
  const u = await db().user.findUnique({ where: { email: body.email } });
  let link: string | null = null;
  if (u && !u.emailVerifiedAt) link = await issueVerification(u.id, u.email);
  return { sent: true, ...(config.isProd ? {} : { devVerificationLink: link }) };
});

auth.post('/login', { auth: 'public', body: loginSchema, summary: 'Sign in (sets an httpOnly session cookie)' }, async ({ body, req, res }) => {
  const invalid = () => unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  const u = await db().user.findUnique({ where: { email: body.email } });
  if (!u || !u.isActive) throw invalid();
  if (u.lockedUntil && u.lockedUntil > new Date()) throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  if (!(await verifyPassword(body.password, u.passwordHash))) {
    const failed = u.failedLoginCount + 1;
    await db().user.update({ where: { id: u.id }, data: { failedLoginCount: failed, lockedUntil: failed >= 5 ? new Date(Date.now() + 15 * 60_000) : null } });
    throw invalid();
  }
  if (!u.emailVerifiedAt) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address before signing in.');
  await db().user.update({ where: { id: u.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const token = randomToken();
  await db().session.create({
    data: { userId: u.id, tokenHash: sha256(token), userAgent: req.headers['user-agent']?.slice(0, 250), ip: req.ip, expiresAt: new Date(Date.now() + config.sessionTtlDays * 86_400_000) },
  });
  setSessionCookie(res, token);
  return null;
});

auth.get('/me', { auth: 'user', summary: 'Current user and workspaces' }, async ({ user }) => mePayload(user.id));

auth.post('/logout', { auth: 'public', summary: 'Sign out' }, async ({ req, res }) => {
  const s = await resolveSession(req);
  if (s) await db().session.update({ where: { id: s.sessionId }, data: { revokedAt: new Date() } });
  res.clearCookie(config.cookieName, { path: '/' });
  return { ok: true };
});

auth.post('/forgot-password', { auth: 'public', body: forgotSchema, summary: 'Request a password reset link' }, async ({ body }) => {
  const u = await db().user.findUnique({ where: { email: body.email } });
  let link: string | null = null;
  if (u && u.isActive) {
    const token = randomToken();
    await db().authToken.create({ data: { userId: u.id, type: 'PASSWORD_RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3_600_000) } });
    link = `${config.webUrl}/reset-password?token=${token}`;
    await sendEmail({ to: u.email, subject: 'Reset your LeadFlow password', body: 'Use the link below to choose a new password. It expires in one hour.', link });
  }
  // Never reveal whether the email exists.
  return { sent: true, ...(config.isProd ? {} : { devResetLink: link }) };
});

auth.post('/reset-password', { auth: 'public', body: resetSchema, summary: 'Set a new password using a reset token' }, async ({ body }) => {
  const t = await db().authToken.findUnique({ where: { tokenHash: sha256(body.token) } });
  if (!t || t.type !== 'PASSWORD_RESET' || t.usedAt || t.expiresAt < new Date()) throw badRequest('This reset link is invalid or has expired.', undefined, 'INVALID_TOKEN');
  await db().authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  await db().user.update({ where: { id: t.userId }, data: { passwordHash: await hashPassword(body.password), failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: new Date() } });
  await db().session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return { reset: true };
});

auth.patch('/profile', { auth: 'user', body: profileSchema, summary: 'Update my profile' }, async ({ user, body }) => {
  await db().user.update({ where: { id: user.id }, data: { name: body.name, phone: body.phone ?? null, jobTitle: body.jobTitle ?? null } });
  return mePayload(user.id);
});

auth.post('/change-password', { auth: 'user', body: changePasswordSchema, summary: 'Change my password' }, async ({ user, body }) => {
  const u = await db().user.findUniqueOrThrow({ where: { id: user.id } });
  if (!(await verifyPassword(body.currentPassword, u.passwordHash))) throw badRequest('Your current password is incorrect', { fields: { currentPassword: 'Incorrect password' } }, 'INVALID_PASSWORD');
  await db().user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await db().session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } }, data: { revokedAt: new Date() } });
  return { changed: true };
});

auth.get('/sessions', { auth: 'user', summary: 'List my active sessions' }, async ({ user }) => {
  const rows = await db().session.findMany({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
  return rows.map((s) => ({ id: s.id, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === user.sessionId }));
});
auth.delete('/sessions/:id', { auth: 'user', summary: 'Revoke one of my sessions' }, async ({ user, params }) => {
  const r = await db().session.updateMany({ where: { id: params.id, userId: user.id }, data: { revokedAt: new Date() } });
  if (!r.count) throw notFound('Session');
  return { revoked: true };
});
auth.post('/sessions/revoke-others', { auth: 'user', summary: 'Sign out of all other devices' }, async ({ user }) => {
  const r = await db().session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } }, data: { revokedAt: new Date() } });
  return { revoked: r.count };
});

// ── Invitations (token based) ──
auth.get('/invitation', { auth: 'public', query: z.object({ token: z.string().min(10) }), summary: 'Preview an invitation' }, async ({ query }) => {
  const [row] = await db().$queryRaw<{ email: string; status: string; expires_at: Date; organization_name: string; role_name: string; invited_by: string | null }[]>`
    SELECT email, status::text, expires_at, organization_name, role_name, invited_by FROM invitation_preview(${sha256(query.token)})`;
  if (!row) throw notFound('Invitation');
  const expired = row.expires_at < new Date();
  const existing = await db().user.findUnique({ where: { email: row.email.toLowerCase() }, select: { id: true } });
  return { email: row.email, organizationName: row.organization_name, roleName: row.role_name, invitedBy: row.invited_by, status: expired && row.status === 'PENDING' ? 'EXPIRED' : row.status, accountExists: !!existing };
});

auth.post('/invitation/accept', { auth: 'user', body: z.object({ token: z.string().min(10) }), summary: 'Accept a workspace invitation' }, async ({ user, body }) => {
  const { acceptInvitation } = await import('../members/service');
  return acceptInvitation(user, body.token);
});

export { forbidden };
