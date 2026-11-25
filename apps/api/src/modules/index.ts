import type { Router } from 'express';
import { auth } from './auth/routes';
import { orgs } from './organizations/routes';
import { members } from './members/routes';
import { lookups } from './lookups/routes';
import { leads } from './leads/routes';
import { leadViews } from './leads/views';
import { attachments } from './attachments/routes';
import { importJobs } from './leads/import-routes';
import { pipelines } from './pipelines/routes';
import { opportunities } from './opportunities/routes';
import { followups } from './followups/routes';
import { calendar } from './followups/calendar';
import { tasks } from './tasks/routes';
import { notifications } from './notifications/routes';
import { activities } from './activities/routes';
import { automations } from './automations/routes';
import { auditLogs } from './audit-logs/routes';
import { billing } from './subscriptions/routes';
import { reports } from './reports/routes';
import { platform } from './platform-admin/routes';
import { system } from './system/routes';
import { sso } from './sso/routes';

export const routers: Router[] = [
  auth.router, orgs.router, members.router, lookups.router, importJobs.router, leads.router, leadViews.router, attachments.router, pipelines.router, opportunities.router, followups.router, calendar.router,
  tasks.router, notifications.router, activities.router, automations.router, auditLogs.router, billing.router, reports.router, platform.router, sso.router, system.router,
];
