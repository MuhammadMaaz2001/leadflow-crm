import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

/**
 * A small OpenID Connect provider for tests (discovery, JWKS, authorization with automatic approval, token endpoint with PKCE verification).
 * It deliberately issues BAD tokens on request (wrong issuer / audience / nonce / signature, expired, unsigned) so the relying party's
 * validation can be proven. It is test code: it implements just enough of the protocol to exercise the application's real client library.
 */
export interface IdpClaims { sub: string; email?: string; email_verified?: boolean | string; name?: string; [k: string]: unknown }
export interface Faults { issuer?: string; audience?: string; expired?: boolean; badSignature?: boolean; unsigned?: boolean; wrongNonce?: boolean; omitNonce?: boolean; denyWith?: string; ignorePkce?: boolean; failToken?: boolean; hsAlg?: boolean }

export class MockIdp {
  url = ''; clientId = 'client-123'; clientSecret = 'super-secret-value';
  claims: IdpClaims = { sub: 'sub-1', email: 'user@acme.test', email_verified: true, name: 'Test User' };
  faults: Faults = {};
  authRequests: URLSearchParams[] = []; tokenRequests: Array<{ body: URLSearchParams; auth?: string }> = [];
  private server!: http.Server; private key!: KeyLike; private other!: KeyLike; private jwk!: JWK;
  private codes = new Map<string, { nonce: string | null; challenge: string | null; redirect: string; claims: IdpClaims }>();

  async start() {
    const k = await generateKeyPair('RS256'); this.key = k.privateKey; this.jwk = { ...(await exportJWK(k.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.other = (await generateKeyPair('RS256')).privateKey;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop() { await new Promise((r) => this.server.close(r)); }
  reset() { this.faults = {}; this.claims = { sub: 'sub-1', email: 'user@acme.test', email_verified: true, name: 'Test User' }; this.authRequests = []; this.tokenRequests = []; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', this.url);
    const json = (o: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: this.url, authorization_endpoint: `${this.url}/authorize`, token_endpoint: `${this.url}/token`, jwks_uri: `${this.url}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], scopes_supported: ['openid', 'email', 'profile'] });
    }
    if (u.pathname === '/jwks') return json({ keys: [this.jwk] });
    if (u.pathname === '/authorize') {
      this.authRequests.push(u.searchParams);
      const redirect = u.searchParams.get('redirect_uri') ?? '';
      if (u.searchParams.get('client_id') !== this.clientId) { res.writeHead(400).end('unknown client'); return; }
      const back = new URL(redirect);
      if (this.faults.denyWith) { back.searchParams.set('error', this.faults.denyWith); back.searchParams.set('state', u.searchParams.get('state') ?? ''); res.writeHead(302, { location: back.toString() }).end(); return; }
      const code = crypto.randomBytes(16).toString('hex');
      this.codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), redirect, claims: { ...this.claims } });
      back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end(); return;
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      this.tokenRequests.push({ body, auth: req.headers.authorization });
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : `${body.get('client_id')}:${body.get('client_secret')}`;
      if (basic !== `${this.clientId}:${this.clientSecret}` && basic !== `${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`) return json({ error: 'invalid_client' }, 401);
      const c = this.codes.get(body.get('code') ?? ''); this.codes.delete(body.get('code') ?? '');
      if (!c || this.faults.failToken) return json({ error: 'invalid_grant' }, 400);
      if (!this.faults.ignorePkce) {
        const verifier = body.get('code_verifier') ?? '';
        if (!c.challenge || crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      }
      if (body.get('redirect_uri') !== c.redirect) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'at-' + crypto.randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: await this.idToken(c) });
    }
    res.writeHead(404).end();
  }

  private async idToken(c: { nonce: string | null; claims: IdpClaims }) {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = { ...c.claims };
    if (!this.faults.omitNonce) payload.nonce = this.faults.wrongNonce ? 'not-the-nonce' : c.nonce;
    const jwt = new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(this.faults.issuer ?? this.url).setAudience(this.faults.audience ?? this.clientId)
      .setIssuedAt(this.faults.expired ? now - 7200 : now).setExpirationTime(this.faults.expired ? now - 3600 : now + 300);
    if (this.faults.unsigned) {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ ...payload, iss: this.url, aud: this.clientId, iat: now, exp: now + 300 })}.`;
    }
    if (this.faults.hsAlg) {            // HS256 signed with the client secret: must never be accepted
      return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuer(this.url).setAudience(this.clientId).setIssuedAt(now).setExpirationTime(now + 300).sign(Buffer.from(this.clientSecret));
    }
    return jwt.sign(this.faults.badSignature ? this.other : this.key);
  }
}
