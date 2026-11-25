import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { audit } from '../../lib/audit';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { encryptSecret, ssoEncryptionAvailable } from '../../lib/secrets';
import { validateIssuerUrl } from '../../lib/idp-guard';
import { lite, usersById } from '../../lib/users';
import { RedirectReply, defineRoutes } from '../../http';
import { callbackUrl, discoverIssuer, resolveOrgBySlug, safeNext, startFlow } from './service';
import { setOrg } from '../../db';

export const sso = defineRoutes('Single sign-on', '');

// ───────────── public: browser entry points ─────────────
const unavailable = (slug: string) => new RedirectReply(`${config.webUrl}/login?sso_error=SSO_NOT_AVAILABLE${slug ? `&workspace=${encodeURIComponent(slug)}` : ''}`);

sso.get('/auth/sso/start', { auth: 'public', query: z.object({ workspace: z.string().trim().min(1).max(80), next: z.string().max(300).optional() }), summary: 'Begin single sign-on for a workspace (redirects to the identity provider)' }, async ({ query, res }) => {
  const orgId = await resolveOrgBySlug(query.workspace);
  if (!orgId) return unavailable(query.workspace);                                  // unknown workspace and "SSO not enabled" are indistinguishable
  await setOrg(orgId);
  const conn = await db().ssoConnection.findUnique({ where: { organizationId: orgId } });
  if (!conn?.enabled) return unavailable(query.workspace);
  try { return new RedirectReply(await startFlow(res, conn, query.workspace.toLowerCase(), 'login', safeNext(query.next))); }
  catch (e) { return new RedirectReply(`${config.webUrl}/login?sso_error=${encodeURIComponent(e instanceof AppError ? e.code : 'IDP_ERROR')}&workspace=${encodeURIComponent(query.workspace)}`); }
});

sso.get('/auth/sso/callback', { auth: 'public', summary: 'Identity provider redirect target: validates the response, signs the user in, redirects to the app' }, async ({ req, res }) => {
  const { completeFlow } = await import('./service');
  return completeFlow(req, res);
});

// ───────────── workspace administration ─────────────
const base = { perm: 'settings.manage' } as const;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const configSchema = z.object({
  name: z.string().trim().min(1).max(80),
  issuer: z.string().trim().min(8).max(300),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().min(1).max(2000).optional(),
  scopes: z.string().trim().max(200).default('openid email profile'),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(DOMAIN, 'Enter domains like example.com')).max(20).default([]),
  allowUnverifiedEmail: z.boolean().default(false),
  jitEnabled: z.boolean().default(false),
  jitRoleId: z.string().uuid().nullable().optional(),
});
const PRIVILEGED = ['roles.manage', 'team.manage', 'settings.manage', 'billing.manage'];

async function statusPayload(orgId: string) {
  const c = await db().ssoConnection.findUnique({ where: { organizationId: orgId } });
  const linked = await db().ssoIdentity.count({ where: { organizationId: orgId } });
  const roles = await db().role.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, systemKey: true, permissions: true }, orderBy: { name: 'asc' } });
  return {
    available: ssoEncryptionAvailable(), callbackUrl: callbackUrl(), loginUrlPath: '/api/auth/sso/start?workspace=',
    eligibleJitRoles: roles.filter((r) => r.systemKey !== 'OWNER' && !r.permissions.some((p) => PRIVILEGED.includes(p))).map((r) => ({ id: r.id, name: r.name })),
    connection: c ? {
      name: c.name, protocol: c.protocol, issuer: c.issuer, clientId: c.clientId, hasSecret: !!c.clientSecretEnc, scopes: c.scopes, allowedEmailDomains: c.allowedEmailDomains, allowUnverifiedEmail: c.allowUnverifiedEmail,
      jitEnabled: c.jitEnabled, jitRoleId: c.jitRoleId, enabled: c.enabled, enforceSso: c.enforceSso, verifiedAt: c.verifiedAt, lastLoginAt: c.lastLoginAt, lastError: c.lastError, lastErrorAt: c.lastErrorAt, linkedUsers: linked,
    } : null,
  };
}

sso.get('/sso', { ...base, summary: 'SSO configuration and status (never includes the client secret)' }, async ({ ctx }) => statusPayload(ctx.orgId));

sso.post('/sso/discover', { ...base, body: z.object({ issuer: z.string().trim().min(8).max(300) }), summary: 'Check an issuer URL: fetches its OpenID discovery document and reports what it supports' }, async ({ body }) => {
  const bad = validateIssuerUrl(body.issuer); if (bad) throw badRequest(bad, { fields: { issuer: bad } }, 'INVALID_ISSUER');
  const i = await discoverIssuer(body.issuer.replace(/\/$/, ''));
  const m = i.metadata as Record<string, unknown>;
  return { issuer: m.issuer, authorizationEndpoint: m.authorization_endpoint, tokenEndpoint: m.token_endpoint, jwksUri: m.jwks_uri, pkceS256: ((m.code_challenge_methods_supported as string[] | undefined) ?? ['S256']).includes('S256'), signingAlgorithms: m.id_token_signing_alg_values_supported };
});

sso.put('/sso', { ...base, body: configSchema, summary: 'Create or update the connection. Changing the issuer, client or secret switches SSO off until it is tested again' }, async ({ ctx, body }) => {
  if (!ssoEncryptionAvailable()) throw new AppError(503, 'SSO_NOT_CONFIGURED', 'Single sign-on is not available: the server has no SSO_ENCRYPTION_KEY configured.');
  const bad = validateIssuerUrl(body.issuer); if (bad) throw badRequest(bad, { fields: { issuer: bad } }, 'INVALID_ISSUER');
  const issuerUrl = body.issuer.replace(/\/$/, '');
  const meta = (await discoverIssuer(issuerUrl)).metadata as Record<string, unknown>;
  const methods = meta.code_challenge_methods_supported as string[] | undefined;
  if (methods && !methods.includes('S256')) throw badRequest('This provider does not support PKCE (S256), which LeadFlow requires.', { fields: { issuer: 'PKCE not supported' } }, 'PKCE_REQUIRED');
  if (!body.scopes.split(/\s+/).includes('openid')) throw badRequest('The scopes must include "openid".', { fields: { scopes: 'Include openid' } });
  if (body.jitEnabled || body.jitRoleId) {
    const role = body.jitRoleId ? await db().role.findFirst({ where: { id: body.jitRoleId, organizationId: ctx.orgId } }) : null;
    if (!role) throw badRequest('Choose the role that new SSO users receive.', { fields: { jitRoleId: 'Required' } });
    if (role.systemKey === 'OWNER' || role.permissions.some((p) => PRIVILEGED.includes(p))) throw badRequest('New SSO users cannot be given an owner or administrator role. Choose a non-administrative role.', { fields: { jitRoleId: 'Too privileged' } }, 'JIT_ROLE_TOO_PRIVILEGED');
  }
  const existing = await db().ssoConnection.findUnique({ where: { organizationId: ctx.orgId } });
  if (!existing && !body.clientSecret) throw badRequest('Enter the client secret from your identity provider.', { fields: { clientSecret: 'Required' } });
  const critical = !existing || existing.issuer !== issuerUrl || existing.clientId !== body.clientId || !!body.clientSecret || existing.scopes !== body.scopes;
  const data = {
    name: body.name, issuer: issuerUrl, clientId: body.clientId, scopes: body.scopes, allowedEmailDomains: [...new Set(body.allowedEmailDomains)], allowUnverifiedEmail: body.allowUnverifiedEmail,
    jitEnabled: body.jitEnabled, jitRoleId: body.jitEnabled ? body.jitRoleId ?? null : null,
    ...(body.clientSecret ? { clientSecretEnc: encryptSecret(body.clientSecret, ctx.orgId) } : {}),
    ...(critical ? { verifiedAt: null, enabled: false, enforceSso: false, lastError: null, lastErrorAt: null } : {}),
    ...(existing?.enabled && body.allowedEmailDomains.length === 0 ? { enabled: false, enforceSso: false } : {}),
  };
  const saved = existing
    ? await db().ssoConnection.update({ where: { id: existing.id }, data })
    : await db().ssoConnection.create({ data: { ...data, organizationId: ctx.orgId, clientSecretEnc: encryptSecret(body.clientSecret!, ctx.orgId), createdById: ctx.userId } as never });
  if (critical) await db().organization.update({ where: { id: ctx.orgId }, data: { ssoEnforced: false } });
  await audit(ctx, existing ? 'sso.config_updated' : 'sso.config_created', 'sso', saved.id, { issuer: issuerUrl, clientId: body.clientId, secretChanged: !!body.clientSecret, domains: data.allowedEmailDomains, jit: data.jitEnabled, resetVerification: critical });
  return { ...(await statusPayload(ctx.orgId)), resetByChange: !!existing && critical };
});

sso.post('/sso/test', { ...base, summary: 'Start a test sign-in with your own account to verify the configuration (does not change any account)' }, async ({ ctx, res }) => {
  const c = await db().ssoConnection.findUnique({ where: { organizationId: ctx.orgId } });
  if (!c) throw notFound('SSO connection');
  const org = await db().organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { slug: true } });
  return { url: await startFlow(res, c, org.slug, 'test', '/settings', ctx.userId) };
});

sso.post('/sso/state', { ...base, body: z.object({ enabled: z.boolean().optional(), enforce: z.boolean().optional() }), summary: 'Switch SSO on / off and require it (SSO-only) — only after a successful test' }, async ({ ctx, body }) => {
  const c = await db().ssoConnection.findUnique({ where: { organizationId: ctx.orgId } });
  if (!c) throw notFound('SSO connection');
  const enabled = body.enabled ?? c.enabled;
  if (body.enforce && !enabled) throw new AppError(409, 'SSO_NOT_ENABLED', 'Switch SSO on before requiring it.');
  const enforce = enabled ? (body.enforce ?? c.enforceSso) : false;
  if (enabled && !c.verifiedAt) throw new AppError(409, 'SSO_NOT_TESTED', 'Run a successful test sign-in before switching SSO on.');
  if (enabled && c.allowedEmailDomains.length === 0) throw new AppError(409, 'SSO_NO_DOMAINS', 'Add at least one allowed e-mail domain first.');
  if (enforce && !c.verifiedAt) throw new AppError(409, 'SSO_NOT_TESTED', 'Run a successful test sign-in before requiring SSO.');
  await db().ssoConnection.update({ where: { id: c.id }, data: { enabled, enforceSso: enforce } });
  await db().organization.update({ where: { id: ctx.orgId }, data: { ssoEnforced: enforce } });
  await audit(ctx, enabled === c.enabled && enforce === c.enforceSso ? 'sso.state_unchanged' : 'sso.state_changed', 'sso', c.id, { enabled, enforce });
  return statusPayload(ctx.orgId);
});

sso.delete('/sso', { ...base, summary: 'Remove the connection (members can use passwords again; linked identities are kept for a later re-creation)' }, async ({ ctx }) => {
  const c = await db().ssoConnection.findUnique({ where: { organizationId: ctx.orgId } });
  if (!c) throw notFound('SSO connection');
  await db().ssoConnection.delete({ where: { id: c.id } });
  await db().organization.update({ where: { id: ctx.orgId }, data: { ssoEnforced: false } });
  await audit(ctx, 'sso.config_deleted', 'sso', c.id, { issuer: c.issuer });
  return { removed: true };
});

sso.get('/sso/identities', { ...base, summary: 'Members linked to the identity provider' }, async ({ ctx }) => {
  const rows = await db().ssoIdentity.findMany({ where: { organizationId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: 200 });
  const u = await usersById(rows.map((r) => r.userId));
  return rows.map((r) => ({ user: lite(u, r.userId), email: r.email, linkedAt: r.createdAt, lastLoginAt: r.lastLoginAt }));
});
sso.delete('/sso/identities/:userId', { ...base, summary: 'Unlink a member from the identity provider (they must sign in and link again)' }, async ({ ctx, params }) => {
  const r = await db().ssoIdentity.deleteMany({ where: { organizationId: ctx.orgId, userId: params.userId! } });
  if (!r.count) throw notFound('Linked identity');
  await audit(ctx, 'sso.identity_unlinked', 'user', params.userId!);
  return { unlinked: true };
});
