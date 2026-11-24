import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { ZodError, type ZodType, z } from 'zod';
import type { PermissionKey, PlanFeature } from '@leadflow/shared';
import { Prisma } from '@leadflow/database';
import { config } from './config';
import { AppError, forbidden, paymentRequired, unauthorized } from './lib/errors';
import { db, prisma, withContext } from './db';
import { sha256 } from './lib/crypto';

export type PlatformRoleName = 'SUPER_ADMIN' | 'SUPPORT_ADMIN' | 'BILLING_ADMIN';

export interface SessionUser {
  id: string; email: string; name: string; platformRole: PlatformRoleName | null; emailVerifiedAt: Date | null; sessionId: string;
}

export interface Ctx {
  userId: string;
  user: SessionUser;
  orgId: string;
  membershipId: string;
  roleId: string;
  roleKey: string | null;
  permissions: string[];
  org: { id: string; name: string; status: string; timezone: string; currency: string; autoAssignMode: string; notContactedHours: number; inactiveDays: number };
  plan: { code: string; name: string; features: string[]; maxLeads: number; maxSeats: number; status: string };
  ip: string | undefined;
  can: (p: PermissionKey) => boolean;
}

export class Reply {
  constructor(public status: number, public body: unknown) {}
}
export class FileReply {
  constructor(public filename: string, public contentType: string, public buffer: Buffer) {}
}
export const created = <T>(data: T) => new Reply(201, { data });
export const paged = <T>(data: T, meta: unknown) => new Reply(200, { data, meta });
export const noContent = () => new Reply(204, null);

export interface RouteOptions<B = unknown, Q = unknown> {
  auth?: 'public' | 'user' | 'org' | 'platform';
  perm?: PermissionKey | PermissionKey[]; // any-of
  feature?: PlanFeature;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  summary?: string;
  /** Allow even when the workspace subscription is expired (read-only mode) — billing endpoints. */
  allowExpired?: boolean;
  /** Allow even when the workspace is suspended. */
  allowSuspended?: boolean;
  platformRoles?: PlatformRoleName[];
  upload?: boolean;
}

export interface HandlerArgs<B, Q> {
  ctx: Ctx;
  user: SessionUser;
  body: B;
  query: Q;
  params: Record<string, string>;
  req: Request;
  res: Response;
}
type Handler<B, Q> = (a: HandlerArgs<B, Q>) => Promise<unknown>;

// ── OpenAPI registry ──
export interface RouteDoc {
  method: string; path: string; summary: string; tag: string; auth: string; perm?: string[]; feature?: string;
  body?: ZodType; query?: ZodType; upload?: boolean;
}
export const routeRegistry: RouteDoc[] = [];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

export async function resolveSession(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.[config.cookieName] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.revokedAt || s.expiresAt < new Date() || !s.user.isActive) return null;
  if (Date.now() - s.lastSeenAt.getTime() > config.sessionIdleDays * 86_400_000) return null; // idle timeout
  if (Date.now() - s.lastSeenAt.getTime() > 60_000) {
    prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  const u = s.user;
  return { id: u.id, email: u.email, name: u.name, platformRole: u.platformRole, emailVerifiedAt: u.emailVerifiedAt, sessionId: s.id };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function buildCtx(req: Request, user: SessionUser, opts: RouteOptions): Promise<Ctx> {
  const raw = req.header('x-org-id');
  if (!raw || !UUID_RE.test(raw)) throw new AppError(400, 'ORG_REQUIRED', 'A valid X-Org-Id header (workspace) is required');
  const tx = db();
  // Tenant access is derived from the authenticated user's membership — never from the header alone.
  const m = await tx.membership.findFirst({ where: { organizationId: raw, userId: user.id }, include: { role: true } });
  if (!m) throw forbidden('You are not a member of this workspace', 'NOT_A_MEMBER');
  if (m.status !== 'ACTIVE') throw forbidden('Your access to this workspace has been deactivated', 'MEMBER_DEACTIVATED');
  const org = await tx.organization.findUnique({ where: { id: raw } });
  if (!org) throw forbidden('Workspace unavailable', 'NOT_A_MEMBER');
  const sub = await tx.subscription.findUnique({ where: { organizationId: raw }, include: { plan: true } });
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (org.status === 'SUSPENDED' && !opts.allowSuspended) throw forbidden('This workspace has been suspended. Contact support.', 'WORKSPACE_SUSPENDED');
  if (isWrite && sub?.status === 'EXPIRED' && !opts.allowExpired) {
    throw new AppError(402, 'SUBSCRIPTION_EXPIRED', 'Your subscription has expired. The workspace is read-only until billing is resolved.');
  }
  const permissions = m.role.permissions;
  return {
    userId: user.id, user, orgId: raw, membershipId: m.id, roleId: m.roleId, roleKey: m.role.systemKey, permissions,
    org: { id: org.id, name: org.name, status: org.status, timezone: org.timezone, currency: org.currency, autoAssignMode: org.autoAssignMode, notContactedHours: org.notContactedHours, inactiveDays: org.inactiveDays },
    plan: sub
      ? { code: sub.plan.code, name: sub.plan.name, features: sub.plan.features, maxLeads: sub.plan.maxLeads, maxSeats: sub.plan.maxSeats, status: sub.status }
      : { code: 'none', name: 'None', features: [], maxLeads: 0, maxSeats: 0, status: 'EXPIRED' },
    ip: req.ip,
    can: (p) => permissions.includes(p),
  };
}

function parseWith<T>(schema: ZodType<T> | undefined, value: unknown): T {
  if (!schema) return undefined as T;
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function validationError(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const i of err.issues) {
    const key = i.path.join('.') || '_';
    if (!fields[key]) fields[key] = i.message;
  }
  const first = Object.values(fields)[0];
  return new AppError(400, 'VALIDATION_ERROR', first ? `Validation failed: ${first}` : 'Validation failed', { fields });
}

function send(res: Response, out: unknown) {
  if (out instanceof FileReply) {
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(out.buffer);
  } else if (out instanceof Reply) {
    if (out.status === 204) res.status(204).end();
    else res.status(out.status).json(out.body);
  } else {
    res.json({ data: out === undefined ? { ok: true } : out });
  }
}

export function route<B = unknown, Q = unknown>(opts: RouteOptions<B, Q>, handler: Handler<B, Q>): RequestHandler[] {
  const auth = opts.auth ?? 'org';
  const main: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = req.params as Record<string, string>;
      // Authentication, tenancy and permission checks happen BEFORE input validation so callers learn nothing about payload rules unless authorised.
      const parsed = () => ({ body: parseWith(opts.body, req.body) as B, query: parseWith(opts.query, req.query) as Q });
      const bad = (k: string) => params[k] && !UUID_RE.test(params[k]) && k.toLowerCase().endsWith('id');
      for (const k of Object.keys(params)) if (bad(k)) throw new AppError(404, 'NOT_FOUND', 'Resource not found');

      let out: unknown;
      if (auth === 'public') {
        out = await withContext({}, async () => handler({ ctx: undefined as unknown as Ctx, user: undefined as unknown as SessionUser, ...parsed(), params, req, res }));
      } else {
        const user = await resolveSession(req);
        if (!user) throw unauthorized();
        if (auth === 'platform') {
          if (!user.platformRole) throw forbidden('Platform administrator access required', 'PLATFORM_ONLY');
          if (opts.platformRoles && !opts.platformRoles.includes(user.platformRole)) throw forbidden('Your platform role cannot perform this action', 'PLATFORM_ROLE');
          out = await handler({ ctx: undefined as unknown as Ctx, user, ...parsed(), params, req, res });
        } else if (auth === 'user') {
          out = await withContext({ userId: user.id }, () => handler({ ctx: undefined as unknown as Ctx, user, ...parsed(), params, req, res }));
        } else {
          const orgHeader = req.header('x-org-id');
          out = await withContext({ userId: user.id, orgId: orgHeader && UUID_RE.test(orgHeader) ? orgHeader : null }, async () => {
            const ctx = await buildCtx(req, user, opts);
            if (opts.perm) {
              const need = Array.isArray(opts.perm) ? opts.perm : [opts.perm];
              if (!need.some((p) => ctx.can(p))) throw forbidden(`Missing permission: ${need.join(' or ')}`, 'MISSING_PERMISSION');
            }
            if (opts.feature && !ctx.plan.features.includes(opts.feature)) {
              throw paymentRequired(`Your ${ctx.plan.name} plan does not include this feature. Upgrade to continue.`, 'FEATURE_NOT_IN_PLAN');
            }
            return handler({ ctx, user, ...parsed(), params, req, res });
          });
        }
      }
      send(res, out);
    } catch (e) {
      next(e);
    }
  };
  return opts.upload ? [upload.single('file'), main] : [main];
}

/** Small typed router wrapper that also feeds the OpenAPI registry. */
export function defineRoutes(tag: string, prefix: string) {
  const router = Router();
  const reg = (method: 'get' | 'post' | 'put' | 'patch' | 'delete') =>
    <B = unknown, Q = unknown>(path: string, opts: RouteOptions<B, Q>, handler: Handler<B, Q>) => {
      routeRegistry.push({
        method, path: `/api${prefix}${path}`.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/', summary: opts.summary ?? `${method.toUpperCase()} ${prefix}${path}`, tag,
        auth: opts.auth ?? 'org', perm: opts.perm ? (Array.isArray(opts.perm) ? opts.perm : [opts.perm]) : undefined, feature: opts.feature,
        body: opts.body as ZodType | undefined, query: opts.query as ZodType | undefined, upload: opts.upload,
      });
      router[method](`${prefix}${path}`.replace(/\/$/, "") || "/", ...route(opts, handler));
    };
  return { router, get: reg('get'), post: reg('post'), put: reg('put'), patch: reg('patch'), delete: reg('delete') };
}

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    const e = validationError(err);
    res.status(400).json({ error: { code: e.code, message: e.message, details: e.details } });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with the same unique value already exists', details: { target: err.meta?.target } } });
      return;
    }
    if (err.code === 'P2003' || err.code === 'P2025') {
      res.status(400).json({ error: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist in this workspace' } });
      return;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/row-level security|violates check constraint/i.test(msg)) {
    res.status(400).json({ error: { code: 'CONSTRAINT_VIOLATION', message: /leads_contact_required/.test(msg) ? 'Provide at least an email or a phone number' : 'The request violates a data integrity rule' } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' } });
    return;
  }
  if (err instanceof Prisma.PrismaClientValidationError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2023')) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'One of the supplied values has an invalid format.' } });
    return;
  }
  if ((err as { code?: string })?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'The file is too large (limit 8 MB).' } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    return;
  }
  if (!config.isTest) console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side' } });
}

export { z };
