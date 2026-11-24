export const FOLLOWUP_TYPES = [
  { value: 'CALL', label: 'Phone Call' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'MEETING', label: 'Meeting' },
  { value: 'VIDEO_CALL', label: 'Video Call' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const FOLLOWUP_OUTCOMES = [
  { value: 'INTERESTED', label: 'Interested' },
  { value: 'NO_ANSWER', label: 'No Answer' },
  { value: 'CALLBACK_REQUESTED', label: 'Callback Requested' },
  { value: 'NOT_INTERESTED', label: 'Not Interested' },
  { value: 'MEETING_SCHEDULED', label: 'Meeting Scheduled' },
  { value: 'SUCCESSFULLY_CONTACTED', label: 'Successfully Contacted' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const PRIORITIES = [
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
] as const;

export const LEAD_STATUSES = [
  { value: 'NEW', label: 'New' },
  { value: 'CONTACTED', label: 'Contacted' },
  { value: 'QUALIFIED', label: 'Qualified' },
  { value: 'CONVERTED', label: 'Won' },
  { value: 'LOST', label: 'Lost' },
] as const;

export const TASK_STATUSES = [
  { value: 'TODO', label: 'To do' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'DONE', label: 'Done' },
  { value: 'CANCELED', label: 'Canceled' },
] as const;

export const ACTIVITY_LABELS: Record<string, string> = {
  LEAD_CREATED: 'Lead created', LEAD_UPDATED: 'Lead updated', LEAD_ASSIGNED: 'Lead assigned', LEAD_REASSIGNED: 'Lead reassigned',
  LEAD_ARCHIVED: 'Lead archived', LEAD_RESTORED: 'Lead restored', LEAD_MERGED: 'Lead merged', STATUS_CHANGED: 'Status changed',
  CALL: 'Call', EMAIL: 'Email', WHATSAPP: 'WhatsApp', MEETING: 'Meeting', NOTE: 'Note',
  FOLLOWUP_SCHEDULED: 'Follow-up scheduled', FOLLOWUP_COMPLETED: 'Follow-up completed', FOLLOWUP_RESCHEDULED: 'Follow-up rescheduled',
  FOLLOWUP_CANCELED: 'Follow-up canceled', TASK_CREATED: 'Task created', TASK_COMPLETED: 'Task completed',
  OPPORTUNITY_CREATED: 'Opportunity created', STAGE_CHANGED: 'Stage changed', OPPORTUNITY_WON: 'Opportunity won', OPPORTUNITY_LOST: 'Opportunity lost',
};

/** Manually loggable interaction types. These count as "contact attempts" in reports. */
export const LOGGABLE_ACTIVITY_TYPES = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'NOTE'] as const;
export const CONTACT_ACTIVITY_TYPES = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING'] as const;

export const NOTIFICATION_TYPES = [
  { value: 'NEW_LEAD', label: 'New lead received' },
  { value: 'LEAD_ASSIGNED', label: 'Lead assigned to me' },
  { value: 'LEAD_REASSIGNED', label: 'Lead reassigned' },
  { value: 'FOLLOWUP_DUE', label: 'Follow-up due' },
  { value: 'FOLLOWUP_OVERDUE', label: 'Follow-up overdue' },
  { value: 'TASK_ASSIGNED', label: 'Task assigned' },
  { value: 'TASK_DEADLINE', label: 'Task deadline approaching' },
  { value: 'LEAD_CONVERTED', label: 'Lead converted' },
  { value: 'LEAD_INACTIVE', label: 'Important lead inactive' },
  { value: 'REMINDER', label: 'Automation reminders' },
  { value: 'BILLING', label: 'Billing & subscription' },
] as const;

export const AUTOMATION_TRIGGERS = [
  { value: 'LEAD_CREATED', label: 'New lead received', hasDelay: false },
  { value: 'LEAD_ASSIGNED', label: 'Lead assigned', hasDelay: false },
  { value: 'LEAD_NOT_CONTACTED', label: 'Lead not contacted within…', hasDelay: true, delayUnit: 'hours' },
  { value: 'FOLLOWUP_OVERDUE', label: 'Follow-up overdue', hasDelay: false },
  { value: 'LEAD_INACTIVE', label: 'Lead inactive for…', hasDelay: true, delayUnit: 'days' },
  { value: 'LEAD_CONVERTED', label: 'Lead converted (won)', hasDelay: false },
] as const;

export const CUSTOM_FIELD_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN'] as const;

export const DEFAULT_STAGES = [
  { name: 'New', kind: 'OPEN', probability: 10, color: '#64748b' },
  { name: 'Contacted', kind: 'OPEN', probability: 20, color: '#0ea5e9' },
  { name: 'Qualified', kind: 'OPEN', probability: 40, color: '#6366f1' },
  { name: 'Meeting Scheduled', kind: 'OPEN', probability: 55, color: '#8b5cf6' },
  { name: 'Proposal Sent', kind: 'OPEN', probability: 70, color: '#f59e0b' },
  { name: 'Negotiation', kind: 'OPEN', probability: 85, color: '#f97316' },
  { name: 'Won', kind: 'WON', probability: 100, color: '#10b981' },
  { name: 'Lost', kind: 'LOST', probability: 0, color: '#ef4444' },
] as const;

export const DEFAULT_SOURCES = [
  ['Website', '#6366f1'], ['Referral', '#10b981'], ['Social Media', '#0ea5e9'], ['Cold Outreach', '#f59e0b'],
  ['Event', '#8b5cf6'], ['Advertising', '#ef4444'], ['Walk-in / Phone', '#64748b'],
] as const;
export const DEFAULT_PRIORITIES = [['Hot', '#ef4444'], ['Warm', '#f59e0b'], ['Cold', '#0ea5e9']] as const;
export const DEFAULT_LOST_REASONS = [
  'Price too high', 'Chose a competitor', 'No budget', 'No response', 'Not a good fit', 'Timing not right', 'Went in-house',
] as const;

export const INDUSTRIES = [
  'Real Estate', 'Software / IT Services', 'Marketing Agency', 'Construction', 'Consulting', 'Education & Training',
  'B2B Sales', 'Professional Services', 'Healthcare', 'Finance & Insurance', 'Other',
] as const;

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'PKR', 'INR', 'AED', 'SAR', 'CAD', 'AUD', 'SGD'] as const;

export const DATE_FORMATS = ['MMM d, yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd'] as const;

export const PLAN_FEATURES = [
  { key: 'import_export', label: 'CSV / Excel import & export' },
  { key: 'automations', label: 'Automation rules' },
  { key: 'custom_pipelines', label: 'Custom pipelines' },
  { key: 'custom_fields', label: 'Custom fields' },
  { key: 'advanced_reports', label: 'Advanced reports & exports' },
  { key: 'custom_roles', label: 'Custom roles & permissions' },
  { key: 'rule_assignment', label: 'Round-robin & rule-based assignment' },
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number]['key'];

/** Default plan catalogue (seeded and used by tests). */
export const DEFAULT_PLANS = [
  { code: 'free', name: 'Free', description: 'For individuals getting started.', priceMonthly: 0, priceYearly: 0, trialDays: 0, maxLeads: 50, maxSeats: 2, features: [] as string[], sortOrder: 1 },
  { code: 'starter', name: 'Starter', description: 'For small sales teams.', priceMonthly: 29, priceYearly: 290, trialDays: 14, maxLeads: 1000, maxSeats: 5,
    features: ['import_export', 'automations', 'custom_fields'], sortOrder: 2 },
  { code: 'professional', name: 'Professional', description: 'For growing teams that need control.', priceMonthly: 79, priceYearly: 790, trialDays: 14, maxLeads: 25000, maxSeats: 25,
    features: ['import_export', 'automations', 'custom_fields', 'custom_pipelines', 'advanced_reports', 'custom_roles', 'rule_assignment'], sortOrder: 3 },
] as const;
