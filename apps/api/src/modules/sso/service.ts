import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Issuer, custom, generators, type Client } from 'openid-client';
import { Prisma } from '@leadflow/database';
import { config } from '../../config';
import { db, setOrg } from '../../db';
import { AppError } from '../../lib/errors';
import { hashPassword, randomToken, sha256 } from '../../lib/crypto';
import { decryptSecret } from '../../lib/secrets';
import { installIdpGuard } from '../../lib/idp-guard';
import { getRedis } from '../../lib/redis';
import { log } from '../../lib/logger';
import { ssoLogins } from '../../lib/metrics';
import { RedirectReply } from '../../http';
import { assertSeatCapacity } from '../subscriptions/service';
import { notify } from '../notifications/service';

/**
 * OpenID Connect sign-in (authorization-code flow with PKCE), one connection per workspace.
 *
 *  Security properties (each is covered by test/sso.test.ts against a local mock identity provider):
 *   • protocol validation is done by `openid-client` (a certified RP library): state, nonce, PKCE verifier, issuer, audience / authorised party,
 *     signature (JWKS, never `alg: none`, never HS* / the client secret), expiry, iat/nbf with 30 s tolerance;
 *   • `state` is a single-use random value held server-side (Redis, 10 min) AND bound to the starting browser by an HttpOnly cookie, so a
 *     callback replayed or injected into another browser (login CSRF) is rejected;
 *   • the redirect URI is built by the server from WEB_URL — nothing from the request can change it — and `next` must be a same-site path;
 *   • an identity is linked by the pair (issuer, subject); an e-mail address alone never logs anyone in. First-time linking by e-mail needs a
 *     VERIFIED e-mail (unless the admin explicitly accepts unverified ones for a single-tenant IdP), an allowed domain, and an ACTIVE membership
 *     (or JIT provisioning explicitly enabled by the workspace); a user already linked to a different subject is refused;
 *   • platform administrators and deactivated users can never sign in through SSO; tokens are never stored or logged.
 */
export const SSO_BIND_COOKIE = 'lf_sso_bind';
const REDIRECT_PATH = '/api/auth/sso/callback';
export const callbackUrl = () => `${config.webUrl.replace(/\/$/, '')}${REDIRECT_PATH}`;

type Conn = Prisma.SsoConnectionGetPayload<Record<string, never>>;
export interface FlowState { orgId: string; slug: string; mode: 'login' | 'test'; nonce: string; verifier: string; bindHash: string; next: string; userId?: string }

// ── discovery (cached; the IdP is reached only through the SSRF guard) ──
const issuers = new Map<string, { issuer: Issuer; until: number }>();
export const resetOidcCache = () => issuers.clear();
export async function discoverIssuer(url: string): Promise<Issuer> {
  installIdpGuard();
  const hit = issuers.get(url);
  if (hit && hit.until > Date.now()) return hit.issuer;
  let issuer: Issuer;
  try { issuer = await Issuer.discover(url); }
  catch (e) { throw new AppError(502, 'IDP_UNREACHABLE', `The identity provider could not be reached or is not a valid OpenID Connect provider (${(e as Error).message.slice(0, 160)}).`); }
  if (issuer.metadata.issuer !== url.replace(/\/$/, '') && issuer.metadata.issuer !== url) throw new AppError(502, 'IDP_ISSUER_MISMATCH', 'The provider reports a different issuer than the one configured.');
  if (issuers.size > 200) issuers.clear();
  issuers.set(url, { issuer, until: Date.now() + 10 * 60_000 });
  return issuer;
}
function signingAlg(issuer: Issuer): string {
  const supported = (issuer.metadata.id_token_signing_alg_values_supported as string[] | undefined) ?? ['RS256'];
  for (const a of ['RS256', 'PS256', 'ES256', 'EdDSA']) if (supported.includes(a)) return a;     // never 'none' and never HMAC (HS*)
  throw new AppError(502, 'IDP_ALG_UNSUPPORTED', 'The provider signs ID tokens with an unsupported algorithm.');
}
export async function oidcClient(conn: Conn): Promise<Client> {
  const issuer = await discoverIssuer(conn.issuer);
  const client = new issuer.Client({ client_id: conn.clientId, client_secret: decryptSecret(conn.clientSecretEnc, conn.organizationId), redirect_uris: [callbackUrl()], response_types: ['code'], id_token_signed_response_alg: signingAlg(issuer) });
  (client as unknown as Record<symbol, number>)[custom.clock_tolerance] = 30;      // seconds of clock skew accepted for exp / iat / nbf
  return client;
}

// ── helpers ──
const stateKey = (state: string) => `sso:state:${sha256(state)}`;
export const safeNext = (n: unknown): string => (typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(n) && !n.includes('\\') && n.length < 300 ? n : '/dashboard');
const fail = (slug: string, code: string) => new RedirectReply(`${config.webUrl}/login?sso_error=${encodeURIComponent(code)}${slug ? `&workspace=${encodeURIComponent(slug)}` : ''}`);
const emailDomain = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

export async function resolveOrgBySlug(slug: string): Promise<string | null> {
  const rows = await db().$queryRaw<Array<{ org_id: string }>>`SELECT org_id FROM sso_resolve_org(${slug.slice(0, 80)}::text)`;
  return rows[0]?.org_id ?? null;
}

/** Creates the authorization request: state + nonce + PKCE stored server-side, bound to this browser by a cookie. Returns the IdP URL. */
export async function startFlow(res: Response, conn: Conn, slug: string, mode: 'login' | 'test', next: string, userId?: string): Promise<string> {
  const client = await oidcClient(conn);
  const state = generators.state(), nonce = generators.nonce(), verifier = generators.codeVerifier(), bind = randomToken();
  const st: FlowState = { orgId: conn.organizationId, slug, mode, nonce, verifier, bindHash: sha256(bind), next: safeNext(next), userId };
  try { await getRedis().set(stateKey(state), JSON.stringify(st), 'EX', config.ssoStateTtlSeconds); }
  catch { throw new AppError(503, 'SSO_UNAVAILABLE', 'Single sign-on is temporarily unavailable. Please try again shortly.'); }
  res.cookie(SSO_BIND_COOKIE, bind, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/api/auth/sso', maxAge: config.ssoStateTtlSeconds * 1000 });
  return client.authorizationUrl({ scope: conn.scopes, state, nonce, code_challenge: generators.codeChallenge(verifier), code_challenge_method: 'S256', redirect_uri: callbackUrl() });
}

async function record(orgId: string, action: string, metadata: Record<string, unknown>, actorId: string | null = null, actorEmail: string | null = null) {
  await db().auditLog.create({ data: { organizationId: orgId, actorId, actorEmail, scope: 'TENANT', action, entityType: 'sso', metadata: metadata as Prisma.InputJsonValue } });
}
async function rememberError(connId: string, code: string) {
  await db().ssoConnection.update({ where: { id: connId }, data: { lastError: code, lastErrorAt: new Date() } });
}
const deny = async (st: FlowState, conn: Conn | null, code: string, extra: Record<string, unknown> = {}) => {
  ssoLogins.inc({ result: code.toLowerCase() });
  await record(st.orgId, 'sso.login_failed', { reason: code, mode: st.mode, ...extra });
  if (conn) await rememberError(conn.id, code);
  if (st.mode === 'test') return new RedirectReply(`${config.webUrl}/settings?tab=sso&sso_test=failed&code=${encodeURIComponent(code)}`);
  return fail(st.slug, code);
};

/** Handles the IdP redirect. Never throws for expected failures: they are recorded, counted and shown to the user as a short code. */
export async function completeFlow(req: Request, res: Response): Promise<RedirectReply> {
  const q = req.query as Record<string, string | undefined>;
  const state = typeof q.state === 'string' ? q.state : '';
  if (!state) return fail('', 'INVALID_REQUEST');
  let raw: string | null = null;
  try { raw = await getRedis().getdel(stateKey(state)); } catch { return fail('', 'SSO_UNAVAILABLE'); }     // single use: a replayed callback finds nothing
  if (!raw) { ssoLogins.inc({ result: 'state_unknown' }); return fail('', 'STATE_EXPIRED'); }
  const st = JSON.parse(raw) as FlowState;
  await setOrg(st.orgId);
  res.clearCookie(SSO_BIND_COOKIE, { path: '/api/auth/sso' });
  const bind = (req.cookies as Record<string, string> | undefined)?.[SSO_BIND_COOKIE];
  const conn = await db().ssoConnection.findUnique({ where: { organizationId: st.orgId } });
  if (!bind || sha256(bind) !== st.bindHash) return deny(st, conn, 'BROWSER_MISMATCH');                    // login CSRF / injected callback
  if (!conn || (!conn.enabled && st.mode === 'login')) return deny(st, conn, 'SSO_DISABLED');
  if (q.error) return deny(st, conn, 'IDP_DENIED', { idpError: String(q.error).slice(0, 60) });
  let claims: { sub: string; email?: string; email_verified?: boolean | string; name?: string; preferred_username?: string };
  try {
    const client = await oidcClient(conn);
    const params = client.callbackParams(req);
    const tokens = await client.callback(callbackUrl(), params, { state, nonce: st.nonce, code_verifier: st.verifier, response_type: 'code' });
    claims = tokens.claims() as typeof claims;
  } catch (e) {
    const name = (e as { name?: string }).name ?? '';
    const code = e instanceof AppError ? e.code : name === 'RPError' ? 'TOKEN_INVALID' : name === 'OPError' ? 'IDP_REJECTED' : 'IDP_ERROR';
    log.warn('sso callback validation failed', { orgId: st.orgId, kind: name, reason: (e as Error).message.slice(0, 200) });   // message may name the failing claim, never contains a token
    return deny(st, conn, code, { detail: (e as Error).message.slice(0, 160) });
  }
  if (!claims.sub) return deny(st, conn, 'TOKEN_INVALID');

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  const identity = await db().ssoIdentity.findUnique({ where: { organizationId_issuer_subject: { organizationId: st.orgId, issuer: conn.issuer, subject: claims.sub } } });
  let userId: string | null = identity?.userId ?? null;
  let linkedNow = false, provisioned = false;

  if (st.mode === 'test') {
    // an administrator checking the configuration: the token was fully validated above; remember that, never change accounts
    const admin = st.userId ? await db().user.findUnique({ where: { id: st.userId } }) : null;
    if (!admin) return deny(st, conn, 'INVALID_REQUEST');
    await db().ssoConnection.update({ where: { id: conn.id }, data: { verifiedAt: new Date(), lastError: null, lastErrorAt: null } });
    await record(st.orgId, 'sso.connection_verified', { subjectKnown: !!identity, emailVerified }, admin.id, admin.email);
    ssoLogins.inc({ result: 'test_ok' });
    return new RedirectReply(`${config.webUrl}/settings?tab=sso&sso_test=ok`);
  }

  if (!userId) {
    if (!email) return deny(st, conn, 'NO_EMAIL');
    if (!emailVerified && !conn.allowUnverifiedEmail) return deny(st, conn, 'EMAIL_NOT_VERIFIED');
    if (!conn.allowedEmailDomains.includes(emailDomain(email))) return deny(st, conn, 'DOMAIN_NOT_ALLOWED', { domain: emailDomain(email) });
    const existing = await db().user.findUnique({ where: { email } });
    if (existing) {
      if (!existing.isActive || existing.platformRole) return deny(st, conn, 'ACCOUNT_NOT_ELIGIBLE');
      const m = await db().membership.findFirst({ where: { organizationId: st.orgId, userId: existing.id } });
      if (m && m.status !== 'ACTIVE') return deny(st, conn, 'NOT_A_MEMBER');
      if (await db().ssoIdentity.findUnique({ where: { organizationId_userId: { organizationId: st.orgId, userId: existing.id } } })) return deny(st, conn, 'IDENTITY_MISMATCH');
      if (!m) {
        if (!conn.jitEnabled || !conn.jitRoleId) return deny(st, conn, 'NOT_A_MEMBER');
        try { await checkSeat(st.orgId); await joinWorkspace(st.orgId, existing.id, conn.jitRoleId); } catch (e) { return deny(st, conn, e instanceof AppError ? e.code : 'JIT_FAILED'); }
        provisioned = true;
      }
      userId = existing.id; linkedNow = true;
    } else {
      if (!conn.jitEnabled || !conn.jitRoleId) return deny(st, conn, 'NO_ACCOUNT');
      try { await checkSeat(st.orgId); } catch (e) { return deny(st, conn, e instanceof AppError ? e.code : 'JIT_FAILED'); }     // before any row is created
      const name = (typeof claims.name === 'string' && claims.name.trim()) || email.split('@')[0]!;
      const u = await db().user.create({ data: { email, name: name.slice(0, 100), passwordHash: await hashPassword(randomToken()), emailVerifiedAt: new Date() } });   // unusable random password: sign-in is via SSO only
      try { await joinWorkspace(st.orgId, u.id, conn.jitRoleId); } catch (e) { return deny(st, conn, e instanceof AppError ? e.code : 'JIT_FAILED'); }
      userId = u.id; linkedNow = true; provisioned = true;
    }
    await db().ssoIdentity.create({ data: { organizationId: st.orgId, userId, issuer: conn.issuer, subject: claims.sub, email: email || null } });
  }

  const user = await db().user.findUniqueOrThrow({ where: { id: userId! } });
  if (!user.isActive || user.platformRole) return deny(st, conn, 'ACCOUNT_NOT_ELIGIBLE');
  const member = await db().membership.findFirst({ where: { organizationId: st.orgId, userId: user.id } });
  if (!member || member.status !== 'ACTIVE') return deny(st, conn, 'NOT_A_MEMBER');

  const token = randomToken();
  await db().session.create({ data: { userId: user.id, tokenHash: sha256(token), userAgent: req.headers['user-agent']?.slice(0, 250), ip: req.ip, expiresAt: new Date(Date.now() + config.sessionTtlDays * 86_400_000), authMethod: 'SSO', ssoOrgId: st.orgId } });
  await db().user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
  await db().ssoIdentity.updateMany({ where: { organizationId: st.orgId, userId: user.id }, data: { lastLoginAt: new Date() } });
  await db().ssoConnection.update({ where: { id: conn.id }, data: { lastLoginAt: new Date(), lastError: null, lastErrorAt: null } });
  await record(st.orgId, 'sso.login', { connection: conn.id, linked: linkedNow, provisioned }, user.id, user.email);
  if (provisioned) await record(st.orgId, 'sso.jit_provisioned', { userId: user.id, roleId: conn.jitRoleId }, user.id, user.email);
  ssoLogins.inc({ result: 'success' });
  res.cookie(config.cookieName, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: config.sessionTtlDays * 86_400_000 });
  return new RedirectReply(`${config.webUrl}${st.next}`);
}

async function checkSeat(orgId: string) {
  const sub = await db().subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } });
  await assertSeatCapacity({ orgId, plan: { code: sub?.plan.code ?? 'none', name: sub?.plan.name ?? 'None', features: sub?.plan.features ?? [], maxLeads: sub?.plan.maxLeads ?? 0, maxSeats: sub?.plan.maxSeats ?? 0, status: sub?.status ?? 'EXPIRED' } });
}
/** Just-in-time membership: seat limit enforced, role restricted when the connection is saved (never owner/admin-level). */
async function joinWorkspace(orgId: string, userId: string, roleId: string) {
  const role = await db().role.findFirst({ where: { id: roleId, organizationId: orgId } });
  if (!role) throw new AppError(409, 'JIT_ROLE_MISSING', 'The role used for new SSO users no longer exists.');
  await db().membership.create({ data: { organizationId: orgId, userId, roleId } });
  const owners = await db().membership.findMany({ where: { organizationId: orgId, status: 'ACTIVE', role: { systemKey: 'OWNER' } }, select: { userId: true } });
  await notify({ userIds: owners.map((o) => o.userId), type: 'SYSTEM', title: 'A new member joined through single sign-on', link: '/team', entityType: 'user', entityId: userId });
}
void createHash;
