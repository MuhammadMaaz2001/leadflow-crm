import { currentStore, db, setOrg } from '../../db';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { sendEmail } from '../../lib/email';
import { config } from '../../config';
import { audit } from '../../lib/audit';
import { assertSeatCapacity } from '../subscriptions/service';
import { assertActiveMember } from '../leads/service';
import { usersById } from '../../lib/users';
import type { Ctx, SessionUser } from '../../http';

/** No privilege escalation: you can only grant roles whose permissions you hold yourself (owners can grant anything). */
export function assertCanGrant(ctx: Ctx, role: { name: string; permissions: string[]; systemKey: string | null }) {
  if (ctx.roleKey === 'OWNER') return;
  if (role.systemKey === 'OWNER') throw forbidden('Only an owner can grant the Owner role', 'PRIVILEGE_ESCALATION');
  const missing = role.permissions.filter((p) => !ctx.permissions.includes(p));
  if (missing.length) throw forbidden(`You cannot grant "${role.name}": it includes permissions you do not have (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}).`, 'PRIVILEGE_ESCALATION');
}

export async function createInvitation(ctx: Ctx, email: string, roleId: string) {
  const role = await db().role.findFirst({ where: { id: roleId, organizationId: ctx.orgId } });
  if (!role) throw notFound('Role');
  assertCanGrant(ctx, role);
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
  return { invitation: inv, link: config.devTools ? link : undefined };
}

export async function acceptInvitation(user: SessionUser, token: string) {
  const tokenHash = sha256(token);
  await db().$executeRaw`SELECT set_config('app.invite_token', ${tokenHash}, true)`;
  const inv = await db().invitation.findUnique({ where: { tokenHash } });
  if (!inv) throw notFound('Invitation');
  await setOrg(inv.organizationId);
  if (inv.status !== 'PENDING' || inv.expiresAt < new Date()) throw new AppError(410, 'INVITATION_INVALID', 'This invitation is no longer valid. Ask for a new one.');
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that address to accept it.`, 'INVITE_EMAIL_MISMATCH');
  // atomic single-use claim (rolled back with the transaction if a later step fails)
  const claimed = await db().invitation.updateMany({ where: { id: inv.id, status: 'PENDING' }, data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedById: user.id } });
  if (claimed.count !== 1) throw new AppError(410, 'INVITATION_INVALID', 'This invitation is no longer valid. Ask for a new one.');
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

export interface Workload { leads: number; followUps: number; tasks: number; opportunities: number }
export async function openWorkload(orgId: string, userId: string): Promise<Workload> {
  const [leads, followUps, tasks, opportunities] = await Promise.all([
    db().lead.count({ where: { organizationId: orgId, assignedToId: userId, archivedAt: null, mergedIntoId: null } }),
    db().followUp.count({ where: { organizationId: orgId, assignedToId: userId, status: 'PENDING' } }),
    db().task.count({ where: { organizationId: orgId, assignedToId: userId, status: { in: ['TODO', 'IN_PROGRESS'] } } }),
    db().opportunity.count({ where: { organizationId: orgId, ownerId: userId, status: 'OPEN', archivedAt: null } }),
  ]);
  return { leads, followUps, tasks, opportunities };
}

/**
 * Hands the open work of a member who is being deactivated to another ACTIVE member of the same workspace (or releases it).
 * History is kept: every moved lead gets an assignment record (method TRANSFER) and a timeline entry. Done with set-based statements
 * so a member with thousands of leads does not turn into thousands of round trips. Closed/archived records are left alone.
 */
export async function transferWorkload(ctx: Ctx, fromUserId: string, to: string | 'UNASSIGN') {
  const toId = to === 'UNASSIGN' ? null : to;
  if (toId) { if (toId === fromUserId) throw new AppError(400, 'INVALID_TRANSFER', 'Choose a different member to take over the work.'); await assertActiveMember(ctx, toId, 'New owner'); }
  const now = new Date();
  const orgId = ctx.orgId;
  const leads = await db().lead.findMany({ where: { organizationId: orgId, assignedToId: fromUserId, archivedAt: null, mergedIntoId: null }, select: { id: true } });
  const ids = leads.map((l) => l.id);
  const names = await usersById([fromUserId, toId]);
  const title = toId ? `Reassigned from ${names.get(fromUserId)?.name ?? 'a former member'} to ${names.get(toId)?.name ?? 'a colleague'}` : `Unassigned (${names.get(fromUserId)?.name ?? 'a former member'} was deactivated)`;
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await db().lead.updateMany({ where: { id: { in: chunk }, organizationId: orgId, assignedToId: fromUserId }, data: { assignedToId: toId, assignedAt: toId ? now : null } });
    await db().leadAssignment.createMany({ data: chunk.map((leadId) => ({ organizationId: orgId, leadId, fromUserId, toUserId: toId, assignedById: ctx.userId, method: 'TRANSFER', note: 'Member deactivated' })) });
    await db().activity.createMany({ data: chunk.map((leadId) => ({ organizationId: orgId, leadId, type: 'LEAD_REASSIGNED' as const, actorId: ctx.userId, title, metadata: { from: fromUserId, to: toId, method: 'TRANSFER' } })) });
  }
  // follow-ups always need an owner: with "unassign" they go to the administrator performing the deactivation
  const followUps = await db().followUp.updateMany({ where: { organizationId: orgId, assignedToId: fromUserId, status: 'PENDING' }, data: { assignedToId: toId ?? ctx.userId } });
  const tasks = await db().task.updateMany({ where: { organizationId: orgId, assignedToId: fromUserId, status: { in: ['TODO', 'IN_PROGRESS'] } }, data: { assignedToId: toId } });
  const opportunities = await db().opportunity.updateMany({ where: { organizationId: orgId, ownerId: fromUserId, status: 'OPEN', archivedAt: null }, data: { ownerId: toId } });
  const moved = { leads: ids.length, followUps: followUps.count, tasks: tasks.count, opportunities: opportunities.count };
  if (toId && (moved.leads || moved.followUps || moved.tasks || moved.opportunities)) {
    const { notify } = await import('../notifications/service');
    await notify({ userIds: [toId], type: 'LEAD_REASSIGNED', title: `${names.get(fromUserId)?.name ?? 'A colleague'}'s work was handed to you`, body: `${moved.leads} leads, ${moved.followUps} follow-ups, ${moved.tasks} tasks, ${moved.opportunities} deals`, link: '/leads', dedupeKey: `transfer:${fromUserId}:${now.getTime()}` });
  }
  return moved;
}
