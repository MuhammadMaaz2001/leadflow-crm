import { z } from 'zod';

const trimmed = (max = 200) => z.string().trim().max(max);
const optionalText = (max = 200) => z.preprocess((v) => (v === '' || v === null ? undefined : v), trimmed(max).optional());
const nullableText = (max = 200) => z.preprocess((v) => (v === '' ? null : v), trimmed(max).nullable().optional());
const uuid = z.string().uuid();
const optionalUuid = z.preprocess((v) => (v === '' ? null : v), uuid.nullable().optional());
const isoDate = z.coerce.date();

export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include at least one letter and one number');

export const registerSchema = z.object({
  name: trimmed(100).min(2, 'Enter your full name'),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: passwordSchema,
});
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});
export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetSchema = z.object({ token: z.string().min(10), password: passwordSchema });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });
export const profileSchema = z.object({
  name: trimmed(100).min(2), phone: nullableText(40), jobTitle: nullableText(100),
});

export const createOrgSchema = z.object({
  name: trimmed(100).min(2, 'Company name is required'),
  industry: optionalText(80),
  planCode: z.string().optional(),
});
export const orgProfileSchema = z.object({
  name: trimmed(100).min(2),
  industry: nullableText(80), website: nullableText(200), contactEmail: z.preprocess((v) => (v === '' ? null : v), z.string().email().nullable().optional()),
  contactPhone: nullableText(40), address: nullableText(300), country: nullableText(80),
  timezone: trimmed(60).optional(), currency: z.string().length(3).optional(), dateFormat: trimmed(30).optional(),
  autoAssignMode: z.enum(['NONE', 'ROUND_ROBIN', 'RULES']).optional(),
  notContactedHours: z.coerce.number().int().min(1).max(720).optional(),
  inactiveDays: z.coerce.number().int().min(1).max(365).optional(),
  logoData: z.string().max(700_000).nullable().optional(),
});
export const onboardingSchema = orgProfileSchema.partial().extend({ complete: z.boolean().optional() });

export const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email(), roleId: uuid });
export const memberUpdateSchema = z.object({
  roleId: uuid.optional(), status: z.enum(['ACTIVE', 'DEACTIVATED']).optional(), isAssignable: z.boolean().optional(),
  /** When deactivating a member who still owns open work: another member's id, or 'UNASSIGN' to release it (follow-ups go to you). */
  transferTo: z.union([uuid, z.literal('UNASSIGN')]).optional(),
});
export const roleSchema = z.object({
  name: trimmed(60).min(2), description: nullableText(200), permissions: z.array(z.string()).max(60),
});

const customFieldValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({});

export const leadSchema = z.object({
  firstName: trimmed(100).min(1, 'First name is required'),
  lastName: optionalText(100),
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().email('Enter a valid email').max(200).optional()),
  phone: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(40).optional()),
  companyName: optionalText(150), jobTitle: optionalText(100),
  sourceId: optionalUuid, campaign: optionalText(150), priorityId: optionalUuid,
  assignedToId: optionalUuid, description: optionalText(5000),
  tagIds: z.array(uuid).max(30).optional(),
  customFields: customFieldValues.optional(),
  allowDuplicate: z.boolean().optional(),
}).refine((v) => !!v.email || !!v.phone, { message: 'Provide at least an email or a phone number', path: ['email'] });

export const leadUpdateSchema = z.object({
  firstName: trimmed(100).min(1).optional(), lastName: nullableText(100),
  email: z.preprocess((v) => (v === '' ? null : v), z.string().trim().email().max(200).nullable().optional()),
  phone: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(40).nullable().optional()),
  companyName: nullableText(150), jobTitle: nullableText(100), sourceId: optionalUuid, campaign: nullableText(150),
  priorityId: optionalUuid, description: nullableText(5000), tagIds: z.array(uuid).max(30).optional(),
  customFields: customFieldValues.optional(),
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'LOST']).optional(), lostReasonId: optionalUuid,
});

export const assignSchema = z.object({ assignedToId: uuid.nullable(), note: optionalText(300) });
export const bulkSchema = z.object({
  ids: z.array(uuid).min(1, 'Select at least one lead').max(500),
  action: z.enum(['assign', 'status', 'archive', 'restore', 'tag', 'priority']),
  assignedToId: uuid.nullable().optional(),
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'LOST']).optional(),
  lostReasonId: optionalUuid, tagId: optionalUuid, priorityId: optionalUuid,
});
export const mergeSchema = z.object({ sourceId: uuid, targetId: uuid, overrides: z.record(z.string(), z.any()).optional() });

export const activityLogSchema = z.object({
  type: z.enum(['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'NOTE']),
  title: optionalText(200), body: optionalText(5000),
  occurredAt: isoDate.optional(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
  durationMinutes: z.coerce.number().int().min(0).max(1440).optional(),
});

export const lookupSchema = z.object({ name: trimmed(80).min(1, 'Name is required'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), position: z.coerce.number().int().optional(), isActive: z.boolean().optional() });
export const customFieldSchema = z.object({
  label: trimmed(80).min(1), key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Lowercase letters, numbers and underscores').optional(),
  type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']), options: z.array(trimmed(80)).max(50).optional(),
  required: z.boolean().optional(), isActive: z.boolean().optional(), position: z.coerce.number().int().optional(),
});

export const pipelineSchema = z.object({ name: trimmed(80).min(2), isDefault: z.boolean().optional() });
export const stageSchema = z.object({
  name: trimmed(60).min(1), probability: z.coerce.number().int().min(0).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), kind: z.enum(['OPEN', 'WON', 'LOST']).optional(),
});
export const stageReorderSchema = z.object({ stageIds: z.array(uuid).min(2) });

export const opportunitySchema = z.object({
  leadId: uuid, pipelineId: optionalUuid, stageId: optionalUuid, name: trimmed(200).min(1, 'Deal name is required'),
  value: z.coerce.number().min(0).max(1e12).default(0), expectedCloseDate: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()),
  ownerId: optionalUuid, notes: optionalText(3000),
});
export const opportunityUpdateSchema = z.object({
  name: trimmed(200).min(1).optional(), value: z.coerce.number().min(0).max(1e12).optional(),
  expectedCloseDate: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()),
  ownerId: optionalUuid, notes: nullableText(3000),
});
export const moveOpportunitySchema = z.object({
  stageId: uuid, beforeId: uuid.nullable().optional(), lostReasonId: optionalUuid, lostNote: optionalText(500),
});

export const followUpSchema = z.object({
  leadId: uuid, opportunityId: optionalUuid, type: z.enum(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'VIDEO_CALL', 'OTHER']).default('CALL'),
  title: optionalText(200), dueAt: isoDate, assignedToId: uuid.optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  notes: optionalText(3000),
});
export const followUpCompleteSchema = z.object({
  outcome: z.enum(['INTERESTED', 'NO_ANSWER', 'CALLBACK_REQUESTED', 'NOT_INTERESTED', 'MEETING_SCHEDULED', 'SUCCESSFULLY_CONTACTED', 'OTHER'], { message: 'Select an outcome' }),
  outcomeNotes: optionalText(3000),
  next: z.object({
    dueAt: isoDate, type: z.enum(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'VIDEO_CALL', 'OTHER']).default('CALL'),
    notes: optionalText(2000), assignedToId: uuid.optional(),
  }).optional(),
});
export const followUpRescheduleSchema = z.object({ dueAt: isoDate, reason: optionalText(300) });
export const followUpCancelSchema = z.object({ reason: optionalText(300) });
export const followUpUpdateSchema = z.object({
  type: z.enum(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'VIDEO_CALL', 'OTHER']).optional(), title: nullableText(200),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(), notes: nullableText(3000), assignedToId: uuid.optional(),
});

export const taskSchema = z.object({
  title: trimmed(200).min(1, 'Title is required'), description: optionalText(5000), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  dueAt: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()), assignedToId: optionalUuid,
  leadId: optionalUuid, opportunityId: optionalUuid,
});
export const taskUpdateSchema = z.object({
  title: trimmed(200).min(1).optional(), description: nullableText(5000), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  dueAt: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()), assignedToId: optionalUuid,
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELED']).optional(),
});
/** Drag-and-drop / dialog rescheduling from the calendar. Either an absolute `start`, or a calendar `date` (+ optional `time`) in the WORKSPACE timezone. */
export const calendarRescheduleSchema = z.object({
  kind: z.enum(['followup', 'task']),
  id: uuid,
  start: isoDate.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm').optional(),
  /** The due date the client believes the item currently has — protects against stale or duplicated drops. */
  expectedStart: isoDate.optional(),
  reason: z.string().trim().max(300).optional(),
}).refine((v) => !!v.start !== !!v.date, { message: 'Provide either start or date', path: ['date'] }).refine((v) => !(v.start && v.time), { message: 'time can only be combined with date', path: ['time'] });
export const commentSchema = z.object({ body: trimmed(3000).min(1, 'Write a comment') });

export const automationSchema = z.object({
  name: trimmed(100).min(2), description: nullableText(300),
  trigger: z.enum(['LEAD_CREATED', 'LEAD_ASSIGNED', 'LEAD_NOT_CONTACTED', 'FOLLOWUP_OVERDUE', 'LEAD_INACTIVE', 'LEAD_CONVERTED']),
  conditions: z.object({
    sourceIds: z.array(uuid).optional(), priorityIds: z.array(uuid).optional(),
    afterHours: z.coerce.number().int().min(1).max(720).optional(), afterDays: z.coerce.number().int().min(1).max(365).optional(),
  }).default({}),
  actions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('NOTIFY'), recipient: z.enum(['OWNER', 'MANAGERS', 'USER']), userId: uuid.optional(), message: optionalText(300) }),
    z.object({ type: z.literal('CREATE_TASK'), title: trimmed(200).min(1), assignee: z.enum(['OWNER', 'MANAGERS', 'USER']).default('OWNER'), userId: uuid.optional(), dueInHours: z.coerce.number().int().min(1).max(720).default(24), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM') }),
    z.object({ type: z.literal('SET_PRIORITY'), priorityId: uuid }),
    z.object({ type: z.literal('ASSIGN_LEAD'), mode: z.enum(['USER', 'ROUND_ROBIN']), userId: uuid.optional(), onlyIfUnassigned: z.boolean().default(true) }),
    z.object({ type: z.literal('CREATE_FOLLOWUP'), followUpType: z.enum(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'VIDEO_CALL', 'OTHER']).default('CALL'), assignee: z.enum(['OWNER', 'MANAGERS', 'USER']).default('OWNER'), userId: uuid.optional(), dueInHours: z.coerce.number().int().min(1).max(720).default(24), notes: optionalText(500) }),
  ])).min(1, 'Add at least one action').max(5),
  isEnabled: z.boolean().optional(),
});

export const assignmentRuleSchema = z.object({
  name: trimmed(100).min(2), isActive: z.boolean().optional(), position: z.coerce.number().int().optional(),
  conditions: z.object({ sourceIds: z.array(uuid).optional(), priorityIds: z.array(uuid).optional(), campaignContains: optionalText(100), companyContains: optionalText(100) }).default({}),
  assigneeIds: z.array(uuid).min(1, 'Select at least one assignee'),
});

export const notificationPrefsSchema = z.object({ prefs: z.array(z.object({ type: z.string(), inApp: z.boolean() })) });

export const changePlanSchema = z.object({ planCode: z.string().min(1), interval: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY') });
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CARD_OFFLINE', 'CHEQUE', 'MOBILE_MONEY', 'OTHER'] as const;
/** Subscription extension: a number of calendar months OR a custom number of days. */
export const extensionSchema = z.object({
  months: z.coerce.number().int().min(1).max(36).optional(),
  days: z.coerce.number().int().min(1).max(1100).optional(),
}).refine((e) => (e.months ? 1 : 0) + (e.days ? 1 : 0) === 1, { message: 'Choose a number of months or a number of days (not both)' });
/** A payment that was received OUTSIDE the system and is being confirmed by a platform administrator. */
export const manualPaymentSchema = z.object({
  invoiceId: uuid.optional(),
  planCode: z.string().trim().min(1).optional(),
  amount: z.coerce.number().positive('Enter the amount received').max(1e9).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  method: z.enum(PAYMENT_METHODS, { message: 'Select how the payment was received' }),
  reference: trimmed(120).min(1, 'Enter a payment reference'),
  receivedAt: z.string().trim().min(8).max(40).optional(),
  extension: extensionSchema.optional(),
  note: optionalText(300),
  internalNote: optionalText(1000),
  allowAmountMismatch: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});
export const extendSubscriptionSchema = z.object({ extension: extensionSchema, reason: trimmed(300).min(5, 'Explain why the subscription is being extended') });
export const reversePaymentSchema = z.object({ reason: trimmed(300).min(5, 'Explain why the payment is being reversed') });
export type ManualPaymentInput = z.infer<typeof manualPaymentSchema>;
export const planAdminSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,30}$/), name: trimmed(60).min(2), description: nullableText(300),
  priceMonthly: z.coerce.number().min(0), priceYearly: z.coerce.number().min(0), trialDays: z.coerce.number().int().min(0).max(120).default(0),
  maxLeads: z.coerce.number().int().min(1), maxSeats: z.coerce.number().int().min(1), features: z.array(z.string()).default([]),
  isPublic: z.boolean().default(true), isActive: z.boolean().default(true), sortOrder: z.coerce.number().int().default(0),
});

export type LeadInput = z.infer<typeof leadSchema>;
export type FollowUpInput = z.infer<typeof followUpSchema>;
export type AutomationInput = z.infer<typeof automationSchema>;
