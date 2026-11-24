# Development Progress

Built from scratch. Stack: Next.js 16 + Tailwind 4 (apps/web), Express + Prisma 6 + PostgreSQL 16 + BullMQ/Redis (apps/api).

## Milestones
- [x] M0 Environment inspected (empty repo, Node 22, PG16, Redis 7 available locally)
- [x] M1 Prisma schema (tenant-aware composite FKs) + migrations + RLS + roles/grants
- [ ] M1 API foundation: auth, orgs, RBAC, tenant tx middleware
- [ ] M2 Web design system + shell
- [ ] M3 Core CRM (leads, pipeline, opportunities)
- [ ] M4 Sales ops (follow-ups, activities, tasks, calendar, notifications)
- [ ] M5 Analytics & reports
- [ ] M6 Automation, billing, platform admin
- [ ] M7 QA: unit/integration/e2e, builds, docs
