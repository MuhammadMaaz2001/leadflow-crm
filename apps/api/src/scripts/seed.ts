/**
 * Development seed — DEVELOPMENT ONLY credentials. Creates a platform admin, two demo workspaces with
 * realistic leads, pipeline activity, follow-ups, tasks, notifications and billing records.
 * All tenant rows are written through the restricted app role, so they are RLS-checked and tenant scoped.
 */
import { randomUUID } from 'node:crypto';
import { addDays, addHours, addMinutes, subDays } from 'date-fns';
import { normalizeEmail, normalizePhone, DEFAULT_PLANS, SYSTEM_ROLES } from '@leadflow/shared';
import { PrismaClient } from '@leadflow/database';
import { config } from '../config';
import { db, prisma, setOrg, withContext } from '../db';
import { hashPassword } from '../lib/crypto';
import { bootstrapWorkspace } from '../modules/organizations/bootstrap';
import { ensurePlans, periodEnd } from '../modules/subscriptions/service';

export const DEMO_PASSWORD = 'Demo#Pass2026';
export const ADMIN_PASSWORD = 'Admin#Pass2026';

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FIRST = ['Aarav', 'Maya', 'Liam', 'Sofia', 'Noah', 'Amara', 'Ethan', 'Zara', 'Lucas', 'Hana', 'Omar', 'Chloe', 'Daniel', 'Ines', 'Mateo', 'Priya', 'Jack', 'Leila', 'Ravi', 'Emma', 'Tariq', 'Grace', 'Kenji', 'Nora', 'Samir', 'Olivia', 'Felix', 'Anika', 'Victor', 'Mei', 'Hugo', 'Yara', 'Isaac', 'Tessa', 'Rohan', 'Elena'];
const LAST = ['Patel', 'Nguyen', 'Garcia', 'Khan', 'Smith', 'Okafor', 'Rossi', 'Tanaka', 'Hughes', 'Haddad', 'Silva', 'Novak', 'Schmidt', 'Kowalski', 'Mehta', 'Dubois', 'Park', 'Andersson', 'Reyes', 'Cohen', 'Ali', 'Fischer', 'Moreau', 'Bennett', 'Sharma', 'Ibrahim', 'Costa', 'Lindqvist'];
const COMPANIES: Record<string, string[]> = {
  re: ['Harbor View Holdings', 'Maple Grove Developers', 'Cedar & Pine Estates', 'Urban Nest Investments', 'Summit Ridge Homes', 'Lakeside Property Group', 'Oakwood Capital', 'Silverline Apartments', 'Greenfield Villas', 'Coastal Living Co', 'Riverside Commons', 'Stonebridge Realty'],
  agency: ['Pixel & Pine', 'Orbit Foods', 'Lumen Fitness', 'Bluebird Coffee Roasters', 'Atlas Outdoor Gear', 'Verde Skincare', 'Nimbus Software', 'Tidal Surf Shop', 'Kite Education', 'Forge Furniture', 'Helix Biotech', 'Harvest Table Restaurants'],
};
const TITLES = ['Founder', 'CEO', 'Operations Manager', 'Head of Growth', 'Marketing Director', 'Procurement Lead', 'Managing Partner', 'Sales Director', 'Owner', 'Project Manager'];
const CAMPAIGNS = ['Spring Open House', 'Q3 Google Ads', 'LinkedIn Outreach', 'Referral Program', 'Webinar: Market Outlook', 'Newsletter Autumn', 'Trade Show 2026', 'Retargeting Sept'];
const TAGS = [['VIP', '#f59e0b'], ['Budget approved', '#10b981'], ['Needs follow-up', '#ef4444'], ['Enterprise', '#6366f1'], ['Referral', '#0ea5e9']] as const;

interface OrgSpec { name: string; industry: string; slug: string; key: 're' | 'agency'; owner: [string, string]; manager: [string, string]; agents: Array<[string, string]>; plan: 'professional' | 'starter'; leads: number; seed: number; currency: string; tz: string }

const ORGS: OrgSpec[] = [
  { name: 'Northwind Realty', industry: 'Real Estate', slug: 'northwind-realty', key: 're', owner: ['Olivia Owens', 'owner@northwind.test'], manager: ['Marcus Hale', 'manager@northwind.test'], agents: [['Sara Ahmed', 'sara@northwind.test'], ['Diego Alvarez', 'diego@northwind.test'], ['Hannah Cole', 'hannah@northwind.test']], plan: 'professional', leads: 42, seed: 11, currency: 'USD', tz: 'America/New_York' },
  { name: 'Brightpath Digital', industry: 'Marketing Agency', slug: 'brightpath-digital', key: 'agency', owner: ['Priya Raman', 'owner@brightpath.test'], manager: ['Tom Becker', 'manager@brightpath.test'], agents: [['Lena Fischer', 'lena@brightpath.test'], ['Jamal Brooks', 'jamal@brightpath.test']], plan: 'starter', leads: 34, seed: 23, currency: 'EUR', tz: 'Europe/Berlin' },
];

async function upsertUser(name: string, email: string, password: string, platformRole?: 'SUPER_ADMIN' | 'SUPPORT_ADMIN' | 'BILLING_ADMIN') {
  const passwordHash = await hashPassword(password);
  return prisma.user.upsert({ where: { email }, update: { name, passwordHash, emailVerifiedAt: new Date(), isActive: true, platformRole: platformRole ?? null }, create: { email, name, passwordHash, emailVerifiedAt: new Date(), platformRole: platformRole ?? null } });
}

async function seedOrg(spec: OrgSpec) {
  const r = rng(spec.seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const now = new Date();
  const users = {
    owner: await upsertUser(spec.owner[0], spec.owner[1], DEMO_PASSWORD),
    manager: await upsertUser(spec.manager[0], spec.manager[1], DEMO_PASSWORD),
    agents: await Promise.all(spec.agents.map(([n, e]) => upsertUser(n, e, DEMO_PASSWORD))),
  };
  const orgId = randomUUID();
  const paidInvoices: Array<Parameters<PrismaClient['invoice']['create']>[0]['data']> = [];
  await withContext({ orgId, userId: users.owner.id }, async () => {
    const tx = db();
    await tx.organization.create({ data: { id: orgId, name: spec.name, slug: spec.slug, industry: spec.industry, timezone: spec.tz, currency: spec.currency, contactEmail: `hello@${spec.slug}.test`, website: `https://${spec.slug}.test`, country: spec.tz.startsWith('Europe') ? 'Germany' : 'United States', createdById: users.owner.id, onboardingCompletedAt: new Date(), autoAssignMode: spec.key === 're' ? 'ROUND_ROBIN' : 'NONE', createdAt: subDays(now, 75) } });
    const { roles } = await bootstrapWorkspace(orgId);
    const mem = async (u: { id: string }, role: string, daysAgo: number) => tx.membership.create({ data: { organizationId: orgId, userId: u.id, roleId: roles[role]!, joinedAt: subDays(now, daysAgo) } });
    await mem(users.owner, 'OWNER', 75); await mem(users.manager, 'MANAGER', 70);
    for (const a of users.agents) await mem(a, 'SALES_AGENT', 60);
    const plan = await tx.subscriptionPlan.findUniqueOrThrow({ where: { code: spec.plan } });
    const start = subDays(now, 20);
    await tx.subscription.create({ data: { organizationId: orgId, planId: plan.id, interval: 'MONTHLY', status: 'ACTIVE', currentPeriodStart: start, currentPeriodEnd: periodEnd(start, 'MONTHLY'), createdAt: subDays(now, 75) } });
    await tx.subscriptionEvent.createMany({ data: [
      { organizationId: orgId, type: 'TRIAL_STARTED', toPlanCode: 'professional', status: 'TRIALING', actorId: users.owner.id, note: '14-day trial', createdAt: subDays(now, 75) },
      { organizationId: orgId, type: 'PLAN_CHANGED', fromPlanCode: 'professional', toPlanCode: spec.plan, status: 'ACTIVE', actorId: users.owner.id, note: 'Invoice recorded as paid (MANUAL_DEV)', createdAt: subDays(now, 60) },
    ] });
    // Paid invoices can only be written by the platform billing role (a database guard blocks the tenant role),
    // so they are collected here and inserted after the tenant transaction, exactly as production billing would.
    for (const d of [60, 30]) {
      paidInvoices.push({ organizationId: orgId, number: `LF-${now.getUTCFullYear()}-${orgId.slice(0, 4).toUpperCase()}-${String(paidInvoices.length + 1).padStart(4, '0')}`, planId: plan.id, interval: 'MONTHLY', description: `${plan.name} plan — monthly ${d === 60 ? 'subscription' : 'renewal'}`, status: 'PAID', amount: plan.priceMonthly, currency: 'USD', periodStart: subDays(now, d), periodEnd: subDays(now, d - 30), issuedAt: subDays(now, d), dueAt: subDays(now, d), paidAt: subDays(now, d), paymentMethod: 'MANUAL_DEV', paymentReference: `SEED-${d}`, recordedById: users.owner.id });
    }

    const sources = await tx.leadSource.findMany({ where: { organizationId: orgId } });
    const prios = await tx.leadPriority.findMany({ where: { organizationId: orgId } });
    const reasons = await tx.lostReason.findMany({ where: { organizationId: orgId } });
    const pipeline = await tx.pipeline.findFirstOrThrow({ where: { organizationId: orgId, isDefault: true }, include: { stages: { orderBy: { position: 'asc' } } } });
    const stage = (name: string) => pipeline.stages.find((s) => s.name === name)!;
    const tags = await Promise.all(TAGS.map(([name, color], i) => tx.tag.create({ data: { organizationId: orgId, name, color, position: i } })));
    await tx.customFieldDef.createMany({ data: spec.key === 're'
      ? [{ organizationId: orgId, key: 'budget', label: 'Budget', type: 'NUMBER' as const, position: 1 }, { organizationId: orgId, key: 'property_type', label: 'Property type', type: 'SELECT' as const, options: ['Apartment', 'House', 'Commercial', 'Land'], position: 2 }]
      : [{ organizationId: orgId, key: 'monthly_budget', label: 'Monthly budget', type: 'NUMBER' as const, position: 1 }, { organizationId: orgId, key: 'service_interest', label: 'Service interest', type: 'SELECT' as const, options: ['SEO', 'Paid Ads', 'Social', 'Branding', 'Web'], position: 2 }] });
    const sellers = [users.manager, ...users.agents];
    await tx.assignmentRule.create({ data: { organizationId: orgId, name: 'Referrals go to the manager', position: 0, conditions: { sourceIds: [sources.find((s) => s.name === 'Referral')!.id] }, assigneeIds: [users.manager.id] } });

    const names = new Set<string>();
    for (let i = 0; i < spec.leads; i++) {
      let first: string, last: string, key: string;
      do { first = pick(FIRST); last = pick(LAST); key = `${first}${last}`; } while (names.has(key));
      names.add(key);
      const createdAt = addMinutes(subDays(now, Math.floor(r() * 58) + (i < 6 ? 0 : 1)), -Math.floor(r() * 600));
      const roll = r();
      const status = roll < 0.16 ? 'NEW' : roll < 0.28 ? 'NEW' : roll < 0.52 ? 'CONTACTED' : roll < 0.7 ? 'QUALIFIED' : roll < 0.84 ? 'CONVERTED' : 'LOST';
      const unassigned = i % 9 === 0 && status === 'NEW';
      const owner = unassigned ? null : pick(sellers);
      const source = pick(sources), priority = pick(prios);
      const contacted = status !== 'NEW' || r() < 0.2;
      const firstContactedAt = contacted ? addMinutes(createdAt, 20 + Math.floor(r() * 60 * 30)) : null;
      const email = `${first}.${last}${i}@${(COMPANIES[spec.key]![i % 12] ?? 'mail').toLowerCase().replace(/[^a-z]/g, '')}.test`;
      const phone = r() < 0.8 ? `+1 ${200 + Math.floor(r() * 700)} 555 ${String(Math.floor(r() * 9000) + 1000)}` : null;
      const leadId = randomUUID();
      const custom = spec.key === 're' ? { budget: (Math.floor(r() * 40) + 10) * 10000, property_type: pick(['Apartment', 'House', 'Commercial', 'Land']) } : { monthly_budget: (Math.floor(r() * 18) + 2) * 500, service_interest: pick(['SEO', 'Paid Ads', 'Social', 'Branding', 'Web']) };
      const lastActivityAt = status === 'NEW' ? createdAt : addDays(firstContactedAt ?? createdAt, Math.floor(r() * 6));
      await tx.lead.create({ data: {
        id: leadId, organizationId: orgId, firstName: first, lastName: last, email, emailNormalized: normalizeEmail(email), phone, phoneNormalized: normalizePhone(phone),
        companyName: COMPANIES[spec.key]![i % 12], jobTitle: pick(TITLES), sourceId: source.id, campaign: r() < 0.6 ? pick(CAMPAIGNS) : null, priorityId: priority.id,
        status, assignedToId: owner?.id ?? null, assignedAt: owner ? addMinutes(createdAt, 5) : null, description: r() < 0.5 ? 'Interested in a call this week. Prefers WhatsApp for quick questions.' : null,
        customFields: custom, createdById: i % 3 === 0 ? users.manager.id : users.owner.id, firstContactedAt, lastActivityAt: lastActivityAt > now ? now : lastActivityAt, createdAt, updatedAt: createdAt,
        // closed leads must carry their closing timestamp (DB check constraints); refined below when an opportunity closes them
        convertedAt: status === 'CONVERTED' ? (lastActivityAt > now ? now : lastActivityAt) : null,
        lostAt: status === 'LOST' ? (lastActivityAt > now ? now : lastActivityAt) : null,
        lostReasonId: status === 'LOST' ? pick(reasons).id : null,
      } });
      if (r() < 0.5) await tx.leadTag.create({ data: { organizationId: orgId, leadId, tagId: pick(tags).id } });
      await tx.activity.create({ data: { organizationId: orgId, leadId, type: 'LEAD_CREATED', actorId: i % 3 === 0 ? users.manager.id : users.owner.id, title: 'Lead created', occurredAt: createdAt, createdAt } });
      if (owner) {
        await tx.leadAssignment.create({ data: { organizationId: orgId, leadId, toUserId: owner.id, assignedById: users.manager.id, method: spec.key === 're' ? 'ROUND_ROBIN' : 'MANUAL', createdAt: addMinutes(createdAt, 5) } });
        await tx.activity.create({ data: { organizationId: orgId, leadId, type: 'LEAD_ASSIGNED', actorId: users.manager.id, title: `Assigned to ${owner.name}`, occurredAt: addMinutes(createdAt, 5), createdAt: addMinutes(createdAt, 5) } });
      }
      if (contacted && owner && firstContactedAt) {
        const t = pick(['CALL', 'WHATSAPP', 'EMAIL'] as const);
        await tx.activity.create({ data: { organizationId: orgId, leadId, type: t, actorId: owner.id, title: t === 'CALL' ? 'Intro call' : t === 'EMAIL' ? 'Sent brochure by email' : 'WhatsApp chat', body: 'Discussed requirements and timeline. Shared next steps.', metadata: { manual: true, durationMinutes: t === 'CALL' ? 8 : null }, occurredAt: firstContactedAt, createdAt: firstContactedAt } });
        if (r() < 0.6) await tx.activity.create({ data: { organizationId: orgId, leadId, type: 'NOTE', actorId: owner.id, title: 'Note added', body: pick(['Decision maker is travelling until next week.', 'Asked for a revised quote with two options.', 'Competitor already pitched; price sensitive.', 'Very engaged — wants to move fast.']), occurredAt: addHours(firstContactedAt, 30), createdAt: addHours(firstContactedAt, 30) } });
      }

      // follow-ups
      if (owner && ['CONTACTED', 'QUALIFIED'].includes(status)) {
        const completedAt = addDays(firstContactedAt ?? createdAt, 1);
        if (completedAt < now) {
          const outcome = pick(['INTERESTED', 'NO_ANSWER', 'CALLBACK_REQUESTED', 'SUCCESSFULLY_CONTACTED', 'MEETING_SCHEDULED'] as const);
          const fu = await tx.followUp.create({ data: { organizationId: orgId, leadId, type: pick(['CALL', 'WHATSAPP', 'MEETING'] as const), dueAt: completedAt, assignedToId: owner.id, createdById: owner.id, priority: pick(['LOW', 'MEDIUM', 'HIGH'] as const), status: 'COMPLETED', completedAt: addMinutes(completedAt, Math.floor(r() * 90) - 20), completedById: owner.id, outcome, outcomeNotes: 'Follow-up done as planned.', createdAt: firstContactedAt ?? createdAt, reminderSentAt: addMinutes(completedAt, -15) } });
          await tx.followUpEvent.createMany({ data: [{ organizationId: orgId, followUpId: fu.id, type: 'CREATED', toDueAt: fu.dueAt, actorId: owner.id, createdAt: fu.createdAt }, { organizationId: orgId, followUpId: fu.id, type: 'COMPLETED', actorId: owner.id, note: outcome, createdAt: fu.completedAt! }] });
          await tx.activity.create({ data: { organizationId: orgId, leadId, type: 'FOLLOWUP_COMPLETED', actorId: owner.id, title: 'Follow-up completed', metadata: { outcome }, occurredAt: fu.completedAt!, createdAt: fu.completedAt! } });
        }
        const bucket = r();
        const dueAt = bucket < 0.25 ? addHours(subDays(now, 1 + Math.floor(r() * 3)), Math.floor(r() * 5)) : bucket < 0.5 ? addHours(now, 1 + Math.floor(r() * 5)) : addDays(now, 1 + Math.floor(r() * 9));
        const fu = await tx.followUp.create({ data: { organizationId: orgId, leadId, type: pick(['CALL', 'CALL', 'WHATSAPP', 'MEETING', 'VIDEO_CALL', 'EMAIL'] as const), title: null, dueAt, assignedToId: owner.id, createdById: owner.id, priority: pick(['MEDIUM', 'HIGH'] as const), notes: pick(['Check on quote decision', 'Walk through proposal', 'Confirm site visit', 'Ask about timeline']), status: 'PENDING', createdAt: subDays(now, 2) } });
        await tx.followUpEvent.create({ data: { organizationId: orgId, followUpId: fu.id, type: 'CREATED', toDueAt: dueAt, actorId: owner.id, createdAt: subDays(now, 2) } });
        await tx.activity.create({ data: { organizationId: orgId, leadId, type: 'FOLLOWUP_SCHEDULED', actorId: owner.id, title: 'Follow-up scheduled', occurredAt: subDays(now, 2), createdAt: subDays(now, 2) } });
      }

      // opportunities
      if (['QUALIFIED', 'CONVERTED', 'LOST'].includes(status) && owner) {
        const open = status === 'QUALIFIED';
        const stageName = open ? pick(['Qualified', 'Meeting Scheduled', 'Proposal Sent', 'Negotiation', 'Contacted']) : status === 'CONVERTED' ? 'Won' : 'Lost';
        const st = stage(stageName);
        const value = (Math.floor(r() * 40) + 3) * (spec.key === 're' ? 2500 : 600);
        const oppCreated = addDays(firstContactedAt ?? createdAt, 2);
        const closedAt = status === 'QUALIFIED' ? null : addDays(oppCreated, 3 + Math.floor(r() * 12));
        const closed = closedAt && closedAt < now ? closedAt : closedAt ? subDays(now, 1) : null;
        const opp = await tx.opportunity.create({ data: {
          organizationId: orgId, leadId, pipelineId: pipeline.id, stageId: st.id, name: spec.key === 're' ? `${last} family — ${pick(['3BR house', 'Downtown apartment', 'Office lease', 'Investment plot'])}` : `${COMPANIES[spec.key]![i % 12]} — ${pick(['SEO retainer', 'Brand refresh', 'Ads management', 'Website rebuild'])}`,
          value, expectedCloseDate: addDays(oppCreated, 20), status: open ? 'OPEN' : status === 'CONVERTED' ? 'WON' : 'LOST', ownerId: owner.id, position: 1024 * (i + 1),
          stageEnteredAt: closed ?? subDays(now, Math.floor(r() * 9)), wonAt: status === 'CONVERTED' ? closed : null, lostAt: status === 'LOST' ? closed : null,
          lostReasonId: status === 'LOST' ? pick(reasons).id : null, createdById: owner.id, createdAt: oppCreated,
        } });
        let prev: string | null = null;
        const path = pipeline.stages.filter((s) => s.kind === 'OPEN' && s.position <= (open ? st.position : 3));
        for (const [pi, s] of [...path, ...(open ? [] : [st])].entries()) {
          if (open && s.id === st.id && pi !== path.length - 1) continue;
          await tx.stageHistory.create({ data: { organizationId: orgId, opportunityId: opp.id, fromStageId: prev, toStageId: s.id, changedById: owner.id, createdAt: addDays(oppCreated, pi) } });
          prev = s.id;
        }
        await tx.activity.create({ data: { organizationId: orgId, leadId, opportunityId: opp.id, type: 'OPPORTUNITY_CREATED', actorId: owner.id, title: `Opportunity created: ${opp.name}`, occurredAt: oppCreated, createdAt: oppCreated } });
        if (!open) await tx.activity.create({ data: { organizationId: orgId, leadId, opportunityId: opp.id, type: status === 'CONVERTED' ? 'OPPORTUNITY_WON' : 'OPPORTUNITY_LOST', actorId: owner.id, title: `${status === 'CONVERTED' ? 'Won' : 'Lost'}: ${opp.name}`, occurredAt: closed!, createdAt: closed! } });
        await tx.lead.update({ where: { id: leadId }, data: { convertedAt: status === 'CONVERTED' ? closed : null, lostAt: status === 'LOST' ? closed : null, lostReasonId: status === 'LOST' ? opp.lostReasonId : null } });
      }
    }

    // tasks
    const taskTitles = ['Prepare proposal deck', 'Send contract for signature', 'Update CRM notes after site visit', 'Call back about pricing', 'Share case study', 'Book demo room', 'Review lead list from event', 'Collect testimonials'];
    const someLeads = await tx.lead.findMany({ where: { organizationId: orgId, assignedToId: { not: null } }, take: 16, orderBy: { createdAt: 'desc' } });
    for (const [i, t] of taskTitles.entries()) {
      const lead = someLeads[i]!;
      const status = i < 2 ? 'DONE' : i === 2 ? 'IN_PROGRESS' : 'TODO';
      await tx.task.create({ data: { organizationId: orgId, title: t, description: 'Seeded demo task.', status, priority: pick(['LOW', 'MEDIUM', 'HIGH'] as const), dueAt: i % 3 === 0 ? subDays(now, 1) : addDays(now, i % 5), assignedToId: lead.assignedToId, createdById: users.manager.id, leadId: lead.id, completedAt: status === 'DONE' ? subDays(now, 1) : null, completedById: status === 'DONE' ? lead.assignedToId : null, createdAt: subDays(now, 6) } });
    }
    const t0 = await tx.task.findFirstOrThrow({ where: { organizationId: orgId } });
    await tx.taskComment.create({ data: { organizationId: orgId, taskId: t0.id, authorId: users.manager.id, body: 'Please prioritise this before Friday.' } });

    // notifications
    for (const u of [users.manager, ...users.agents]) {
      await tx.notification.createMany({ data: [
        { organizationId: orgId, userId: u.id, type: 'LEAD_ASSIGNED', title: 'New lead assigned', body: 'A new lead is waiting for your first contact.', link: '/leads', createdAt: subDays(now, 1) },
        { organizationId: orgId, userId: u.id, type: 'FOLLOWUP_OVERDUE', title: 'You have overdue follow-ups', body: 'Open Follow-ups to catch up.', link: '/follow-ups?view=overdue', createdAt: addHours(subDays(now, 1), 3) },
        { organizationId: orgId, userId: u.id, type: 'TASK_DEADLINE', title: 'Task deadline approaching', body: 'A task is due soon.', link: '/tasks', createdAt: addHours(now, -3), readAt: addHours(now, -2) },
      ] });
    }
    for (let d = 14; d >= 0; d--) {
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - d));
      await tx.usageRecord.create({ data: { organizationId: orgId, day, leads: Math.round(spec.leads * (1 - d * 0.015)), seats: 2 + spec.agents.length, opportunities: Math.round(spec.leads * 0.45), followUps: 20 + (14 - d) } });
    }
    await tx.auditLog.createMany({ data: [
      { organizationId: orgId, actorId: users.owner.id, actorEmail: users.owner.email, action: 'workspace.created', entityType: 'organization', entityId: orgId, createdAt: subDays(now, 75) },
      { organizationId: orgId, actorId: users.owner.id, actorEmail: users.owner.email, action: 'billing.payment_recorded_manually', entityType: 'invoice', metadata: { method: 'MANUAL_DEV' }, createdAt: subDays(now, 60) },
    ] });
    // keep automation seed enabled/disabled according to plan: professional gets all templates, starter keeps them too
    void setOrg; void SYSTEM_ROLES; void DEFAULT_PLANS;
  });
  const platform = new PrismaClient({ datasourceUrl: config.ownerDatabaseUrl });
  try { for (const data of paidInvoices) await platform.invoice.create({ data }); } finally { await platform.$disconnect(); }
  return { orgId, users };
}

export async function seed() {
  console.log('Seeding development data (development-only credentials)…');
  await ensurePlans();
  // fresh demo data: remove prior demo orgs (cascade) so the seed is repeatable
  const owner = new PrismaClient({ datasourceUrl: config.ownerDatabaseUrl });
  await owner.organization.deleteMany({ where: { slug: { in: ORGS.map((o) => o.slug) } } });
  await owner.$disconnect();
  await upsertUser('Platform Super Admin', 'admin@leadflow.test', ADMIN_PASSWORD, 'SUPER_ADMIN');
  await upsertUser('Support Admin', 'support@leadflow.test', ADMIN_PASSWORD, 'SUPPORT_ADMIN');
  await upsertUser('Billing Admin', 'billing@leadflow.test', ADMIN_PASSWORD, 'BILLING_ADMIN');
  const orgIds: Record<string, string> = {};
  for (const spec of ORGS) { const o = await seedOrg(spec); orgIds[spec.slug] = o.orgId; console.log(`  ✓ ${spec.name} (${o.orgId})`); }
  // multi-organization demo: Marcus (manager at Northwind) is also a sales agent at Brightpath
  const marcus = await prisma.user.findUniqueOrThrow({ where: { email: 'manager@northwind.test' } });
  const [bp] = await prisma.$queryRaw<{ id: string }[]>`SELECT o.id FROM organizations o WHERE false`.catch(() => []);
  void bp;
  const bpOrg = orgIds['brightpath-digital']!;
  await withContext({ orgId: bpOrg, userId: marcus.id }, async () => {
    const role = await db().role.findFirstOrThrow({ where: { organizationId: bpOrg, systemKey: 'SALES_AGENT' } });
    await db().membership.create({ data: { organizationId: bpOrg, userId: marcus.id, roleId: role.id } });
  });
  console.log('Done. See README for the demo accounts.');
}

if (require.main === module) seed().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
