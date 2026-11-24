import { currentStore, db, setOrg } from '../../db';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { sendEmail } from '../../lib/email';
import { config } from '../../config';
import { audit } from '../../lib/audit';
import { assertSeatCapacity } from '../subscriptions/service';
import type { Ctx, SessionUser } from '../../http';

export async function createInvitation(ctx: Ctx, email: string, roleId: string) {
  const role = await db().role.findFirst({ where: { id: roleId, organizationId: ctx.orgId } });
  if (!role) throw notFound('Role');
  if (role.systemKey === 'OWNER' && ctx.roleKey !== 'OWNER') throw forbidden('Only an owner can invite another owner');
  const existingUser = await db().user.findUnique({ where: { email } });
  if (existingUser) {
    const m = await db().membership.findFirst({ where: { organizationId: ctx.orgId, userId: existingUser.id } });
    if (m) throw new AppError(409, 'ALREADY_MEMBER', 'This person is already a member of the workspace');
  }
  await assertSeatCapacity(ctx);
  await db().invitation.updateMany({ where: { organizationId: ctx.orgId, email, status: 'PENDING' }, data: { status: 'REVOKED' } });
  const token = randomToken();
  const inv = await db().invitation.create({
    data: { organizationId: ctx.orgId, email, roleId, tokenHash: sha256(token), invitedById: ctx.userId, expiresAt: new Date(Date.now() + 7 * 86_400_000) },
  });
  const link = `${config.webUrl}/accept-invite?token=${token}`;
  await sendEmail({ to: email, subject: `${ctx.user.name} invited you to ${ctx.org.name} on LeadFlow`, body: `You have been invited to join ${ctx.org.name} as ${role.name}.`, link });
  await audit(ctx, 'member.invited', 'invitation', inv.id, { email, role: role.name });
  return { invitation: inv, link: config.isProd ? undefined : link };
}

export async function acceptInvitation(user: SessionUser, token: string) {
  const tokenHash = sha256(token);
  await db().$executeRaw`SELECT set_config('app.invite_token', ${tokenHash}, true)`;
  const inv = await db().invitation.findUnique({ where: { tokenHash } });
  if (!inv) throw notFound('Invitation');
  await setOrg(inv.organizationId);
  if (inv.status !== 'PENDING' || inv.expiresAt < new Date()) throw new AppError(410, 'INVITATION_INVALID', 'This invitation is no longer valid. Ask for a new one.');
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that address to accept it.`, 'INVITE_EMAIL_MISMATCH');
  const org = await db().organization.findUniqueOrThrow({ where: { id: inv.organizationId } });
  const existing = await db().membership.findFirst({ where: { organizationId: inv.organizationId, userId: user.id } });
  if (!existing) {
    const sub = await db().subscription.findUnique({ where: { organizationId: inv.organizationId }, include: { plan: true } });
    const seats = await db().membership.count({ where: { organizationId: inv.organizationId, status: 'ACTIVE' } });
    if (sub && seats + 1 > sub.plan.maxSeats) throw new AppError(402, 'SEAT_LIMIT_REACHED', 'This workspace has no free seats left. Ask an owner to upgrade the plan.');
    await db().membership.create({ data: { organizationId: inv.organizationId, userId: user.id, roleId: inv.roleId } });
  } else if (existing.status === 'DEACTIVATED') {
    await db().membership.update({ where: { id: existing.id }, data: { status: 'ACTIVE', roleId: inv.roleId, deactivatedAt: null } });
  }
  await db().invitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedById: user.id } });
  await db().auditLog.create({ data: { organizationId: inv.organizationId, actorId: user.id, actorEmail: user.email, action: 'member.joined', entityType: 'invitation', entityId: inv.id, metadata: {} } });
  const { notify, managerIds } = await import('../notifications/service');
  await notify({ userIds: await managerIds(), type: 'SYSTEM', title: `${user.name} joined ${org.name}`, link: '/team', exceptUserId: user.id });
  void currentStore();
  return { organizationId: inv.organizationId, organizationName: org.name };
}

export async function ensureNotLastOwner(ctx: Ctx, membershipId: string) {
  const target = await db().membership.findFirst({ where: { id: membershipId, organizationId: ctx.orgId }, include: { role: true } });
  if (!target) throw notFound('Member');
  if (target.role.systemKey === 'OWNER') {
    const owners = await db().membership.count({ where: { organizationId: ctx.orgId, status: 'ACTIVE', role: { systemKey: 'OWNER' } } });
    if (owners <= 1) throw new AppError(409, 'LAST_OWNER', 'A workspace must keep at least one active owner.');
  }
  return target;
}
