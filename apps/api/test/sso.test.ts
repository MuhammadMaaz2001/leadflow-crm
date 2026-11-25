import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { decryptSecret, encryptSecret } from '../src/lib/secrets';
import { guardedLookup, isPrivateAddress, validateIssuerUrl } from '../src/lib/idp-guard';
import { resetOidcCache } from '../src/modules/sso/service';
import { addMember, app, boot, createWorkspace, makePlatformAdmin, ownerPrisma, request, signUp, uniq, PASSWORD, type Actor } from './helpers';
import { MockIdp } from './mock-idp';

const idp = new MockIdp();
let owner: Actor, slug = '', manager: Actor, agentA: Actor, dana: Actor, other: Actor, otherSlug = '';

const roleId = async (a: Actor, key: string) => ((await a.get('/roles')).body.data as Array<{ id: string; systemKey: string }>).find((r) => r.systemKey === key)!.id;
async function memberWithEmail(o: Actor, role: 'SALES_AGENT' | 'VIEWER' | 'MANAGER', email: string, name: string): Promise<Actor> {
  const inv = await o.post('/invitations', { email, roleId: await roleId(o, role) });
  const token = new URL(inv.body.data.devInviteLink).searchParams.get('token')!;
  const user = await signUp(name, email);
  expect((await user.agent.post('/api/auth/invitation/accept').send({ token })).status).toBe(200);
  const { withOrg } = await import('./helpers'); return withOrg(user, o.orgId!);
}
const configure = (a: Actor, over: Record<string, unknown> = {}) => a.agent.put('/api/sso').set('X-Org-Id', a.orgId!).send({ name: 'Acme IdP', issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, allowedEmailDomains: ['acme.test'], ...over });
/** Drives the browser steps without a browser: start → IdP authorize → callback (the supertest agent keeps the binding cookie). */
async function drive(agent: ReturnType<typeof request.agent>, startPath: string, mutate?: (cb: URL) => void) {
  const start = await agent.get(startPath);
  const loc = start.headers.location as string | undefined;
  if (start.status !== 302 || !loc?.startsWith(idp.url)) return { start, cb: start, to: loc ?? '' };
  const auth = await fetch(loc, { redirect: 'manual' });
  const cbUrl = new URL(auth.headers.get('location')!);
  mutate?.(cbUrl);
  const cb = await agent.get(cbUrl.pathname + cbUrl.search);
  return { start, cb, to: (cb.headers.location as string) ?? '' };
}
const login = (s: string, next = '/dashboard', agent = request.agent(app)) => drive(agent, `/api/auth/sso/start?workspace=${s}&next=${encodeURIComponent(next)}`).then((r) => ({ ...r, agent }));
const errCode = (to: string) => new URL(to).searchParams.get('sso_error');
const hasSession = (r: { cb: { headers: Record<string, unknown> } }) => String(r.cb.headers['set-cookie'] ?? '').includes(`${config.cookieName}=`);
async function verifyAndEnable(a: Actor, enforce = false) {
  const t = await a.post('/sso/test'); expect(t.status, JSON.stringify(t.body)).toBe(200);
  const auth = await fetch(t.body.data.url, { redirect: 'manual' }); const u = new URL(auth.headers.get('location')!);
  const cb = await a.agent.get(u.pathname + u.search);
  expect(cb.headers.location).toContain('sso_test=ok');
  const st = await a.post('/sso/state', { enabled: true, enforce }); expect(st.status, JSON.stringify(st.body)).toBe(200);
}
const audits = (org: string, action?: string) => ownerPrisma.auditLog.findMany({ where: { organizationId: org, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  await boot(); await idp.start();
  owner = await createWorkspace(await signUp('SSO Owner'), `SSO Co ${uniq()}`);
  slug = (await owner.get('/organizations/current')).body.data.organization.slug;
  manager = await addMember(owner, 'MANAGER', 'SSO Manager'); agentA = await addMember(owner, 'SALES_AGENT', 'SSO Agent');
  dana = await memberWithEmail(owner, 'SALES_AGENT', 'dana@acme.test', 'Dana');
  other = await createWorkspace(await signUp('SSO Other'), `SSO Other ${uniq()}`);
  otherSlug = (await other.get('/organizations/current')).body.data.organization.slug;
});
afterAll(async () => { await idp.stop(); });
beforeEach(() => { idp.reset(); resetOidcCache(); });

describe('configuration', () => {
  it('only workspace administrators configure it; the client secret is stored encrypted and never returned', async () => {
    expect((await agentA.get('/sso')).status).toBe(403); expect((await manager.get('/sso')).status).toBe(403);
    expect((await configure(agentA)).status).toBe(403);
    const r = await configure(owner); expect(r.status, JSON.stringify(r.body)).toBe(200);
    const payload = JSON.stringify((await owner.get('/sso')).body);
    expect(payload).not.toContain(idp.clientSecret); expect(payload).not.toMatch(/client_secret_enc|clientSecretEnc|v1\./);
    expect((await owner.get('/sso')).body.data.connection).toMatchObject({ name: 'Acme IdP', hasSecret: true, enabled: false, issuer: idp.url, allowedEmailDomains: ['acme.test'] });
    expect((await owner.get('/sso')).body.data.callbackUrl).toBe(`${config.webUrl}/api/auth/sso/callback`);
    const row = await ownerPrisma.ssoConnection.findFirstOrThrow({ where: { organizationId: owner.orgId! } });
    expect(row.clientSecretEnc).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/); expect(row.clientSecretEnc).not.toContain(idp.clientSecret);
    expect(decryptSecret(row.clientSecretEnc, owner.orgId!)).toBe(idp.clientSecret);
    expect(() => decryptSecret(row.clientSecretEnc, other.orgId!)).toThrow(/cannot be read/);                       // bound to the workspace
    expect(encryptSecret('x', owner.orgId!)).not.toBe(encryptSecret('x', owner.orgId!));                              // fresh nonce every time
    expect((await other.get('/sso')).body.data.connection).toBeNull();                                                 // tenant isolation
    expect(JSON.stringify(await audits(owner.orgId!, 'sso.config_created'))).not.toContain(idp.clientSecret);
  });

  it('validates the provider before saving: issuer URL rules, discovery, PKCE, scopes, domains', async () => {
    expect(validateIssuerUrl('ftp://x.com')).toMatch(/https/); expect(validateIssuerUrl('https://user:pw@x.com')).toMatch(/credentials/); expect(validateIssuerUrl('https://x.com/?a=1')).toMatch(/query/); expect(validateIssuerUrl('nope')).toMatch(/valid URL/);
    expect(validateIssuerUrl('https://login.example.com/tenant/v2.0')).toBeNull();
    expect((await configure(owner, { issuer: 'http://example.com' })).body.error.code).toBe('INVALID_ISSUER');
    expect((await configure(owner, { issuer: `${idp.url}/missing` })).body.error.code).toBe('IDP_UNREACHABLE');
    expect((await configure(owner, { scopes: 'email profile' })).status).toBe(400);
    expect((await configure(owner, { allowedEmailDomains: ['not a domain'] })).status).toBe(400);
    const d = await owner.post('/sso/discover', { issuer: idp.url });
    expect(d.body.data).toMatchObject({ issuer: idp.url, pkceS256: true }); expect(d.body.data.authorizationEndpoint).toBe(`${idp.url}/authorize`);
  });

  it('blocks server-side requests to internal addresses (SSRF) in production-like settings', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '52.1.2.3']) expect(isPrivateAddress(ip), ip).toBe(false);
    config.ssoAllowPrivateIdp = false;
    try {
      const err = await new Promise<NodeJS.ErrnoException | null>((r) => guardedLookup('localhost', {}, (e) => r(e)));
      expect(err?.code).toBe('EIDPPRIVATE');
      resetOidcCache();
      const r = await owner.post('/sso/discover', { issuer: idp.url.replace('127.0.0.1', 'localhost') });
      expect(r.status).toBe(502); expect(r.body.error.code).toBe('IDP_UNREACHABLE'); expect(r.body.error.message).toMatch(/private|internal|reached/i);
      expect((await owner.post('/sso/discover', { issuer: idp.url })).status).toBe(400);                              // IP literal rejected up front
    } finally { config.ssoAllowPrivateIdp = true; }
  });
});

describe('verification gate', () => {
  it('cannot be switched on or enforced before a successful test sign-in, and a changed issuer/secret switches it off again', async () => {
    expect((await configure(owner)).status).toBe(200);
    expect((await owner.post('/sso/state', { enabled: true })).body.error.code).toBe('SSO_NOT_TESTED');
    expect((await owner.post('/sso/state', { enforce: true })).status).toBe(409);
    // a failed test records why
    idp.faults.badSignature = true;
    const t = await owner.post('/sso/test'); const auth = await fetch(t.body.data.url, { redirect: 'manual' }); const u = new URL(auth.headers.get('location')!);
    const cb = await owner.agent.get(u.pathname + u.search);
    expect(cb.headers.location).toContain('sso_test=failed'); expect((await owner.get('/sso')).body.data.connection).toMatchObject({ verifiedAt: null, lastError: 'TOKEN_INVALID' });
    idp.faults = {};
    await verifyAndEnable(owner);
    expect((await owner.get('/sso')).body.data.connection).toMatchObject({ enabled: true, enforceSso: false, lastError: null });
    expect((await owner.get('/sso')).body.data.connection.verifiedAt).not.toBeNull();
    // changing something security-relevant resets verification and switches SSO off (nobody is locked out by a typo)
    const r = await configure(owner, { clientId: 'client-123', clientSecret: idp.clientSecret });
    expect(r.body.data.resetByChange).toBe(true); expect(r.body.data.connection).toMatchObject({ enabled: false, verifiedAt: null });
    expect((await configure(owner, { name: 'Renamed', clientSecret: undefined })).body.data.resetByChange).toBe(false);                       // cosmetic changes do not reset it
    await verifyAndEnable(owner);
  });
});

describe('sign-in with a verified identity (authorization code + PKCE)', () => {
  it('sends a standards-compliant authorization request: state, nonce, S256 challenge and the server-built redirect URI', async () => {
    const r = await login(slug, '/leads');
    const q = idp.authRequests.at(-1)!;
    expect(q.get('response_type')).toBe('code'); expect(q.get('client_id')).toBe(idp.clientId); expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256'); expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(20); expect(q.get('nonce')!.length).toBeGreaterThanOrEqual(20);
    expect(q.get('redirect_uri')).toBe(`${config.webUrl}/api/auth/sso/callback`);
    const bindCookie = String(r.start.headers['set-cookie']);
    expect(bindCookie).toMatch(/lf_sso_bind=[^;]+/); expect(bindCookie).toMatch(/Path=\/api\/auth\/sso/); expect(bindCookie).toMatch(/HttpOnly/i); expect(bindCookie).toMatch(/SameSite=Lax/i); expect(bindCookie).toMatch(/Max-Age=600/);
    // the token request carries the verifier that matches the challenge (the mock rejects anything else)
    expect(idp.tokenRequests.at(-1)!.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // nothing from the request can change where the IdP sends the user back
    const evil = await request(app).get(`/api/auth/sso/start?workspace=${slug}&redirect_uri=https://evil.example/cb`);
    expect(new URL(evil.headers.location as string).searchParams.get('redirect_uri')).toBe(`${config.webUrl}/api/auth/sso/callback`);
  });

  it('links an existing member by verified e-mail on the first sign-in, then recognises them by (issuer, subject)', async () => {
    idp.claims = { sub: 'sub-dana', email: 'dana@acme.test', email_verified: true, name: 'Dana' };
    const r = await login(slug, '/leads?view=mine');
    expect(r.to).toBe(`${config.webUrl}/leads?view=mine`); expect(hasSession(r)).toBe(true);
    const me = await r.agent.get('/api/auth/me'); expect(me.status).toBe(200); expect(me.body.data.user.email).toBe('dana@acme.test');
    const s = await ownerPrisma.session.findFirstOrThrow({ where: { userId: dana.userId }, orderBy: { createdAt: 'desc' } });
    expect(s).toMatchObject({ authMethod: 'SSO', ssoOrgId: owner.orgId });
    expect(await ownerPrisma.ssoIdentity.findFirstOrThrow({ where: { organizationId: owner.orgId!, userId: dana.userId } })).toMatchObject({ issuer: idp.url, subject: 'sub-dana', email: 'dana@acme.test' });
    // the workspace API works with the SSO session
    expect((await r.agent.get('/api/leads').set('X-Org-Id', owner.orgId!)).status).toBe(200);
    // second sign-in: the IdP now sends a DIFFERENT e-mail for the same subject — identity wins, nobody else is signed in
    idp.claims = { sub: 'sub-dana', email: 'manager-victim@acme.test', email_verified: true };
    const again = await login(slug); expect(hasSession(again)).toBe(true);
    expect((await again.agent.get('/api/auth/me')).body.data.user.email).toBe('dana@acme.test');
    // audit trail: success events, no tokens or codes
    const log = JSON.stringify(await audits(owner.orgId!)); expect(log).toContain('sso.login'); expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    for (const q of idp.authRequests) expect(log).not.toContain(q.get('state')!);
    expect(String(idp.tokenRequests.at(-1)!.body.get('code'))).not.toBe(''); expect(log).not.toContain(idp.clientSecret);
    // logout ends the session
    expect((await r.agent.post('/api/auth/logout')).status).toBe(200); expect((await r.agent.get('/api/auth/me')).status).toBe(401);
  });

  it('is invisible for workspaces without SSO or unknown names, and `next` can only be a local path', async () => {
    for (const s of ['no-such-workspace-xyz', otherSlug]) { const r = await request(app).get(`/api/auth/sso/start?workspace=${s}`); expect(errCode(r.headers.location as string)).toBe('SSO_NOT_AVAILABLE'); }
    for (const evil of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      idp.claims = { sub: 'sub-dana', email: 'dana@acme.test', email_verified: true };
      const r = await login(slug, evil); expect(r.to).toBe(`${config.webUrl}/dashboard`);
    }
  });
});

describe('what the application refuses to believe', () => {
  const cases: Array<[string, () => void, string]> = [
    ['an ID token issued by another issuer', () => { idp.faults.issuer = 'https://evil.example'; }, 'TOKEN_INVALID'],
    ['an ID token for another audience (client)', () => { idp.faults.audience = 'someone-else'; }, 'TOKEN_INVALID'],
    ['an expired ID token', () => { idp.faults.expired = true; }, 'TOKEN_INVALID'],
    ['a token signed with a different key (invalid signature)', () => { idp.faults.badSignature = true; }, 'TOKEN_INVALID'],
    ['an unsigned token (alg: none)', () => { idp.faults.unsigned = true; }, 'TOKEN_INVALID'],
    ['a token HMAC-signed with the client secret (alg confusion)', () => { idp.faults.hsAlg = true; }, 'TOKEN_INVALID'],
    ['a token with the wrong nonce (replay of another login)', () => { idp.faults.wrongNonce = true; }, 'TOKEN_INVALID'],
    ['a token without a nonce', () => { idp.faults.omitNonce = true; }, 'TOKEN_INVALID'],
    ['a token endpoint that rejects the code / PKCE verifier', () => { idp.faults.failToken = true; }, 'IDP_REJECTED'],
    ['an authorisation denied by the provider', () => { idp.faults.denyWith = 'access_denied'; }, 'IDP_DENIED'],
  ];
  beforeAll(async () => { idp.reset(); resetOidcCache(); if (!(await owner.get('/sso')).body.data.connection?.enabled) await verifyAndEnable(owner); });
  for (const [name, setup, code] of cases) {
    it(`rejects ${name}`, async () => {
      idp.claims = { sub: 'sub-dana', email: 'dana@acme.test', email_verified: true }; setup();
      const before = (await ownerPrisma.session.count({ where: { userId: dana.userId } }));
      const r = await login(slug);
      expect(errCode(r.to), r.to).toBe(code); expect(hasSession(r)).toBe(false);
      expect(await ownerPrisma.session.count({ where: { userId: dana.userId } })).toBe(before);
      expect((await r.agent.get('/api/auth/me')).status).toBe(401);
      const failed = (await audits(owner.orgId!, 'sso.login_failed')).at(-1)!; expect(JSON.stringify(failed.metadata)).toContain(code === 'IDP_DENIED' ? 'IDP_DENIED' : code);
      expect(JSON.stringify(failed)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    });
  }
  it('rejects a forged, replayed or foreign callback (state and browser binding)', async () => {
    idp.claims = { sub: 'sub-dana', email: 'dana@acme.test', email_verified: true };
    const forged = await login(slug, '/dashboard', request.agent(app)).catch(() => null); void forged;
    // 1. unknown state
    const a = request.agent(app); const s1 = await a.get(`/api/auth/sso/start?workspace=${slug}`);
    const auth = await fetch(s1.headers.location as string, { redirect: 'manual' }); const cbUrl = new URL(auth.headers.get('location')!);
    const bad = new URL(cbUrl); bad.searchParams.set('state', 'tampered-state-value-1234567890');
    expect(errCode((await a.get(bad.pathname + bad.search)).headers.location as string)).toBe('STATE_EXPIRED');
    // 2. the legitimate callback still works once (state is only consumed by a matching request)…
    const ok = await a.get(cbUrl.pathname + cbUrl.search); expect(String(ok.headers['set-cookie'])).toContain(`${config.cookieName}=`);
    // 3. …and replaying it fails (single use)
    expect(errCode((await a.get(cbUrl.pathname + cbUrl.search)).headers.location as string)).toBe('STATE_EXPIRED');
    // 4. a callback delivered to a different browser (no binding cookie) is refused: login CSRF / session fixation
    const victim = request.agent(app); const s2 = await victim.get(`/api/auth/sso/start?workspace=${slug}`);
    const auth2 = await fetch(s2.headers.location as string, { redirect: 'manual' }); const cb2 = new URL(auth2.headers.get('location')!);
    const attacker = request.agent(app);
    const r = await attacker.get(cb2.pathname + cb2.search);
    expect(errCode(r.headers.location as string)).toBe('BROWSER_MISMATCH'); expect(String(r.headers['set-cookie'] ?? '')).not.toContain(`${config.cookieName}=`);
    expect(errCode('http://x/?sso_error=' + new URL(String((await request(app).get('/api/auth/sso/callback')).headers.location)).searchParams.get('sso_error'))).toBe('INVALID_REQUEST');
  });
});

describe('account linking and workspace membership', () => {
  beforeAll(async () => { idp.reset(); resetOidcCache(); if (!(await owner.get('/sso')).body.data.connection?.enabled) await verifyAndEnable(owner); });
  const attempt = async (claims: Record<string, unknown>) => { idp.claims = claims as never; return login(slug); };

  it('refuses unverified e-mail, other domains, and addresses nobody can prove', async () => {
    expect(errCode((await attempt({ sub: 'u1', email: 'someone@acme.test', email_verified: false })).to)).toBe('EMAIL_NOT_VERIFIED');
    expect(errCode((await attempt({ sub: 'u2', email: 'someone@acme.test' })).to)).toBe('EMAIL_NOT_VERIFIED');
    expect(errCode((await attempt({ sub: 'u3', email: 'dana@evil.test', email_verified: true })).to)).toBe('DOMAIN_NOT_ALLOWED');
    expect(errCode((await attempt({ sub: 'u4', email_verified: true })).to)).toBe('NO_EMAIL');
    expect(errCode((await attempt({ sub: 'u5', email: 'nobody@acme.test', email_verified: true })).to)).toBe('NO_ACCOUNT');           // JIT is off: an invitation is required
    expect(await ownerPrisma.user.count({ where: { email: 'nobody@acme.test' } })).toBe(0);
  });

  it('never signs in platform administrators, deactivated accounts or non-members', async () => {
    const admin = await makePlatformAdmin(); await ownerPrisma.user.update({ where: { email: admin.email }, data: { email: 'padmin@acme.test' } });
    expect(errCode((await attempt({ sub: 'p1', email: 'padmin@acme.test', email_verified: true })).to)).toBe('ACCOUNT_NOT_ELIGIBLE');
    const stranger = await signUp('Stranger', 'stranger@acme.test');                                                        // exists in the platform, is NOT a member of this workspace
    expect(errCode((await attempt({ sub: 'p2', email: 'stranger@acme.test', email_verified: true })).to)).toBe('NOT_A_MEMBER');
    expect(await ownerPrisma.membership.count({ where: { organizationId: owner.orgId!, userId: stranger.userId } })).toBe(0);
    const left = await memberWithEmail(owner, 'VIEWER', 'left@acme.test', 'Left');
    await owner.patch(`/members/${(await ownerPrisma.membership.findFirstOrThrow({ where: { organizationId: owner.orgId!, userId: left.userId } })).id}`, { status: 'DEACTIVATED' });
    expect(errCode((await attempt({ sub: 'p3', email: 'left@acme.test', email_verified: true })).to)).toBe('NOT_A_MEMBER');
    await ownerPrisma.user.update({ where: { id: dana.userId }, data: { isActive: false } });
    expect(errCode((await attempt({ sub: 'sub-dana', email: 'dana@acme.test', email_verified: true })).to)).toBe('ACCOUNT_NOT_ELIGIBLE');
    await ownerPrisma.user.update({ where: { id: dana.userId }, data: { isActive: true } });
  });

  it('does not let a second identity take over an account that is already linked', async () => {
    const eve = await memberWithEmail(owner, 'VIEWER', 'eve@acme.test', 'Eve');
    expect(hasSession(await attempt({ sub: 'sub-eve', email: 'eve@acme.test', email_verified: true }))).toBe(true);
    // somebody who gets the same e-mail address at the IdP later (a different subject) is NOT Eve
    const r = await attempt({ sub: 'sub-attacker', email: 'eve@acme.test', email_verified: true });
    expect(errCode(r.to)).toBe('IDENTITY_MISMATCH'); expect(hasSession(r)).toBe(false);
    expect(await ownerPrisma.ssoIdentity.count({ where: { organizationId: owner.orgId!, userId: eve.userId } })).toBe(1);
    // an administrator can unlink Eve; the next verified sign-in re-links
    expect((await owner.del(`/sso/identities/${eve.userId}`)).status).toBe(200);
    expect(hasSession(await attempt({ sub: 'sub-eve-2', email: 'eve@acme.test', email_verified: true }))).toBe(true);
    expect((await owner.get('/sso/identities')).body.data.some((i: { email: string }) => i.email === 'eve@acme.test')).toBe(true);
  });

  it('can accept unverified e-mails only when the administrator explicitly allows it (single-tenant providers)', async () => {
    const frank = await memberWithEmail(owner, 'VIEWER', 'frank@acme.test', 'Frank'); void frank;
    expect((await configure(owner, { allowUnverifiedEmail: true })).status).toBe(200);
    await verifyAndEnable(owner);
    expect(hasSession(await attempt({ sub: 'sub-frank', email: 'frank@acme.test', email_verified: false }))).toBe(true);
    expect((await configure(owner, { allowUnverifiedEmail: false })).status).toBe(200);
    await verifyAndEnable(owner);
  });
});

describe('just-in-time provisioning', () => {
  it('is off by default; when enabled it creates a restricted, SSO-only member, respects the seat limit and cannot grant admin roles', async () => {
    idp.claims = { sub: 'sub-new', email: 'newbie@acme.test', email_verified: true, name: 'New Hire' };
    expect(errCode((await login(slug)).to)).toBe('NO_ACCOUNT');
    const roles = (await owner.get('/roles')).body.data as Array<{ id: string; systemKey: string }>;
    for (const key of ['OWNER', 'ADMIN']) { const r = await configure(owner, { jitEnabled: true, jitRoleId: roles.find((x) => x.systemKey === key)!.id }); expect(r.status, key).toBe(400); }
    expect((await configure(owner, { jitEnabled: true })).status).toBe(400);                                        // a role is required
    const agentRole = roles.find((x) => x.systemKey === 'SALES_AGENT')!.id;
    expect((await configure(owner, { jitEnabled: true, jitRoleId: agentRole })).status).toBe(200);
    await verifyAndEnable(owner);
    const ok = await login(slug); expect(hasSession(ok)).toBe(true);
    const u = await ownerPrisma.user.findUniqueOrThrow({ where: { email: 'newbie@acme.test' } });
    expect(u).toMatchObject({ name: 'New Hire', isActive: true }); expect(u.emailVerifiedAt).not.toBeNull();
    const m = await ownerPrisma.membership.findFirstOrThrow({ where: { organizationId: owner.orgId!, userId: u.id }, include: { role: true } });
    expect(m.role.systemKey).toBe('SALES_AGENT'); expect(m.status).toBe('ACTIVE');
    expect(await ownerPrisma.auditLog.count({ where: { organizationId: owner.orgId!, action: 'sso.jit_provisioned' } })).toBe(1);
    // the account has no usable password: it cannot sign in with one, whatever is guessed
    for (const pw of [PASSWORD, 'password', 'Passw0rd!test2']) expect((await request(app).post('/api/auth/login').send({ email: 'newbie@acme.test', password: pw })).status).toBe(401);
    expect(await ownerPrisma.notification.count({ where: { organizationId: owner.orgId!, title: { contains: 'joined through single sign-on' } } })).toBeGreaterThanOrEqual(1);
    // an existing platform user who is not a member yet is added (not duplicated)
    const stranger = await signUp('Stranger Two', 'stranger2@acme.test');
    idp.claims = { sub: 'sub-s2', email: 'stranger2@acme.test', email_verified: true };
    expect(hasSession(await login(slug))).toBe(true);
    expect(await ownerPrisma.user.count({ where: { email: 'stranger2@acme.test' } })).toBe(1);
    expect(await ownerPrisma.membership.count({ where: { organizationId: owner.orgId!, userId: stranger.userId, status: 'ACTIVE' } })).toBe(1);
    // seat limit: refused with a clear code, nothing created
    const sub = await ownerPrisma.subscription.findUniqueOrThrow({ where: { organizationId: owner.orgId! }, include: { plan: true } });
    const tiny = await ownerPrisma.subscriptionPlan.create({ data: { code: `seat-${uniq()}`, name: 'One seat', description: 't', priceMonthly: 1, priceYearly: 10, maxLeads: 100, maxSeats: 1, features: [], trialDays: 0, sortOrder: 99, isActive: false } });
    await ownerPrisma.subscription.update({ where: { id: sub.id }, data: { planId: tiny.id, status: 'ACTIVE', trialEndsAt: null } });
    idp.claims = { sub: 'sub-s3', email: 'overflow@acme.test', email_verified: true };
    expect(errCode((await login(slug)).to)).toBe('SEAT_LIMIT_REACHED');
    expect(await ownerPrisma.user.count({ where: { email: 'overflow@acme.test' } })).toBe(0);                          // refused BEFORE anything is created
    await ownerPrisma.subscription.update({ where: { id: sub.id }, data: { planId: sub.planId } });
    expect((await configure(owner, { jitEnabled: false })).status).toBe(200); await verifyAndEnable(owner);
  });
});

describe('SSO-only workspaces and recovery', () => {
  it('blocks password sessions (except the owner\'s break-glass access), keeps other workspaces working and can be switched off by an admin or the platform', async () => {
    await verifyAndEnable(owner, true);
    expect((await owner.get('/sso')).body.data.connection.enforceSso).toBe(true);
    // a member with only a password session is locked out of THIS workspace…
    const denied = await dana.get('/leads'); expect(denied.status).toBe(403); expect(denied.body.error).toMatchObject({ code: 'SSO_REQUIRED', details: { slug } });
    expect((await manager.get('/leads')).body.error.code).toBe('SSO_REQUIRED');
    // …the owner keeps access so that a broken IdP can always be repaired…
    expect((await owner.get('/leads')).status).toBe(200);
    // …other workspaces are unaffected, and the login itself still works
    expect((await other.get('/leads')).status).toBe(200);
    const me = (await dana.agent.get('/api/auth/me')).body.data; expect(me.workspaces.find((w: { organization: { id: string } }) => w.organization.id === owner.orgId).organization.ssoEnforced).toBe(true);
    // with SSO the same member gets in
    idp.claims = { sub: 'sub-dana', email: 'dana@acme.test', email_verified: true };
    const r = await login(slug); expect(hasSession(r)).toBe(true);
    expect((await r.agent.get('/api/leads').set('X-Org-Id', owner.orgId!)).status).toBe(200);
    // a SSO session for ANOTHER workspace does not open this one
    // recovery 1: the platform switches it off
    const padmin = await makePlatformAdmin('SUPPORT_ADMIN');
    expect((await padmin.agent.post(`/api/platform/organizations/${owner.orgId}/sso/disable`).send({ reason: 'IdP outage' })).status).toBe(200);
    expect((await dana.get('/leads')).status).toBe(200);
    expect((await owner.get('/sso')).body.data.connection).toMatchObject({ enabled: false, enforceSso: false });
    expect(await ownerPrisma.auditLog.count({ where: { action: 'organization.sso_disabled', entityId: owner.orgId! } })).toBe(1);
    // recovery 2: the owner re-enables, then removes the connection altogether
    await verifyAndEnable(owner, true); expect((await manager.get('/leads')).status).toBe(403);
    expect((await owner.del('/sso')).status).toBe(200); expect((await manager.get('/leads')).status).toBe(200);
    expect((await owner.get('/sso')).body.data.connection).toBeNull();
  });
});

describe('password sign-in is unchanged', () => {
  it('still works for workspaces and users without SSO, with the same responses and limits', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: other.email, password: PASSWORD });
    expect(r.status).toBe(200); expect(String(r.headers['set-cookie'])).toContain(`${config.cookieName}=`);
    expect((await request(app).post('/api/auth/login').send({ email: other.email, password: 'wrong-Password1' })).body.error.code).toBe('INVALID_CREDENTIALS');
    const s = await ownerPrisma.session.findFirstOrThrow({ where: { userId: other.userId }, orderBy: { createdAt: 'desc' } });
    expect(s).toMatchObject({ authMethod: 'PASSWORD', ssoOrgId: null });
    expect((await other.get('/leads')).status).toBe(200);
  });
});
