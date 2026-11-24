export const PERMISSION_GROUPS = [
  {
    group: 'Dashboard & reports',
    items: [
      { key: 'dashboard.view_all', label: 'View company-wide dashboard', description: 'Without this, dashboards only show the member\'s own data.' },
      { key: 'reports.view', label: 'View reports', description: 'Open Reports & Analytics (scoped to own data unless "View all reports").' },
      { key: 'reports.view_all', label: 'View all reports', description: 'See reports for every team member.' },
      { key: 'reports.export', label: 'Export reports', description: 'Download CSV / Excel reports.' },
    ],
  },
  {
    group: 'Leads',
    items: [
      { key: 'leads.view_all', label: 'View all leads', description: 'Without this, members only see leads assigned to or created by them.' },
      { key: 'leads.create', label: 'Create leads', description: '' },
      { key: 'leads.update', label: 'Edit leads', description: 'Edit, tag and log activity on visible leads.' },
      { key: 'leads.archive', label: 'Archive & restore leads', description: '' },
      { key: 'leads.assign', label: 'Assign leads', description: 'Assign, reassign and bulk-assign leads.' },
      { key: 'leads.merge', label: 'Merge duplicate leads', description: '' },
      { key: 'leads.import', label: 'Import leads', description: 'CSV / Excel import.' },
      { key: 'leads.export', label: 'Export leads', description: 'CSV / Excel export.' },
    ],
  },
  {
    group: 'Pipeline & follow-ups',
    items: [
      { key: 'opportunities.view_all', label: 'View all opportunities', description: '' },
      { key: 'opportunities.manage', label: 'Manage opportunities', description: 'Create, move, win or lose opportunities.' },
      { key: 'followups.view_all', label: 'View all follow-ups', description: '' },
      { key: 'followups.manage', label: 'Manage follow-ups', description: 'Schedule, complete, reschedule and cancel.' },
      { key: 'tasks.view_all', label: 'View all tasks', description: '' },
      { key: 'tasks.manage', label: 'Manage tasks', description: '' },
      { key: 'activity.view_all', label: 'View workspace activity log', description: '' },
    ],
  },
  {
    group: 'Team & configuration',
    items: [
      { key: 'team.view', label: 'View team members', description: '' },
      { key: 'team.manage', label: 'Manage team', description: 'Invite, deactivate and change roles.' },
      { key: 'roles.manage', label: 'Manage roles & permissions', description: '' },
      { key: 'automations.manage', label: 'Manage automations', description: '' },
      { key: 'settings.manage', label: 'Manage workspace settings', description: 'Company profile, sources, pipelines, custom fields.' },
      { key: 'billing.view', label: 'View billing', description: '' },
      { key: 'billing.manage', label: 'Manage subscription & billing', description: '' },
    ],
  },
] as const;

export type PermissionKey = (typeof PERMISSION_GROUPS)[number]['items'][number]['key'];
export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key)) as PermissionKey[];

const P = (...k: PermissionKey[]) => k;

export interface SystemRoleDef { key: string; name: string; description: string; permissions: PermissionKey[] }

export const SYSTEM_ROLES: SystemRoleDef[] = [
  { key: 'OWNER', name: 'Owner', description: 'Full control of the workspace, including billing.', permissions: [...ALL_PERMISSIONS] },
  {
    key: 'ADMIN', name: 'Admin', description: 'Manages the workspace and team. Cannot change billing.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'billing.manage'),
  },
  {
    key: 'MANAGER', name: 'Manager', description: 'Oversees leads, assignment, team performance and reports.',
    permissions: P('dashboard.view_all', 'reports.view', 'reports.view_all', 'reports.export', 'leads.view_all', 'leads.create', 'leads.update', 'leads.archive',
      'leads.assign', 'leads.merge', 'leads.import', 'leads.export', 'opportunities.view_all', 'opportunities.manage', 'followups.view_all', 'followups.manage',
      'tasks.view_all', 'tasks.manage', 'activity.view_all', 'team.view', 'automations.manage'),
  },
  {
    key: 'SALES_AGENT', name: 'Sales Agent', description: 'Works their own leads, follow-ups, tasks and deals.',
    permissions: P('reports.view', 'leads.create', 'leads.update', 'opportunities.manage', 'followups.manage', 'tasks.manage', 'team.view'),
  },
  {
    key: 'VIEWER', name: 'Viewer', description: 'Read-only access to company data.',
    permissions: P('dashboard.view_all', 'reports.view', 'reports.view_all', 'leads.view_all', 'opportunities.view_all', 'followups.view_all', 'tasks.view_all', 'team.view'),
  },
];

export function hasPermission(perms: readonly string[], key: PermissionKey): boolean {
  return perms.includes(key);
}
