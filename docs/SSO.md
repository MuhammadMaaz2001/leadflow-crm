# Single sign-on (OpenID Connect)

## Scope
Per-workspace OIDC (authorization-code flow with PKCE). SAML 2.0 is **not** implemented (the architecture — `sso_connections.protocol` — leaves room for it). Email + password sign-in keeps working for every workspace that does not require SSO.

## How it works
1. A workspace owner/administrator (`settings.manage`) saves the connection under **Settings → Single sign-on**: issuer URL, client id, client secret, scopes, allowed e-mail domains, optional JIT role. The server fetches the issuer's discovery document, requires PKCE (S256) and a signing algorithm it accepts (RS256/PS256/ES256/EdDSA — never `none`, never HMAC).
2. **Test sign-in** (administrator's own account): runs the full flow and records "verified" without changing any account. SSO can only be switched on — and only then required — after a successful test; changing the issuer, client id, secret or scopes resets verification and switches SSO off (nobody is locked out by a typo).
3. Members sign in via `/login` → "Sign in with single sign-on" → workspace name → `GET /api/auth/sso/start?workspace=<slug>` → IdP → `GET <WEB_URL>/api/auth/sso/callback`. The redirect URI is built by the server from `WEB_URL` (register exactly `https://<app>/api/auth/sso/callback`).
4. `openid-client` (a certified relying-party library) validates state, nonce, PKCE verifier, issuer, audience/azp, signature (JWKS), expiry/iat/nbf (30 s tolerance). Application checks follow only after that.

## Security controls
* State is single-use, held server-side (Redis, 10 min) and bound to the starting browser by an `HttpOnly; SameSite=Lax; Path=/api/auth/sso` cookie → replayed/forged/foreign callbacks are refused (`STATE_EXPIRED`, `BROWSER_MISMATCH`).
* `next` must be a same-site path; nothing in the request can change `redirect_uri`.
* **Linking**: an identity is the pair (issuer, subject). First sign-in links by e-mail only when the IdP says `email_verified` (unless the admin explicitly accepts unverified e-mails for a single-tenant IdP), the domain is on the allow-list, and the user is an **active member** — or JIT is explicitly enabled. A user already linked to another subject is refused (`IDENTITY_MISMATCH`); a known subject always resolves to its own user even if the e-mail claim changes. Platform administrators and deactivated users can never sign in through SSO.
* **JIT** (off by default): creates the user (random unusable password, e-mail marked verified) and a membership with the configured role — owner/admin-level roles are refused when saving; the seat limit is checked before anything is created; owners are notified.
* **Secrets**: the client secret is encrypted with AES-256-GCM (`SSO_ENCRYPTION_KEY`, workspace id bound as AAD), never returned by any API, never logged or put in the audit trail. Tokens are never stored.
* **SSRF**: issuer must be https (http only for localhost outside production), no credentials/query; in production every connection to the IdP is refused when the host resolves to a private, loopback, link-local or metadata address (checked inside the socket's DNS lookup, so DNS rebinding cannot swap it); 8 s timeout, no retries.
* **Audit/metrics**: `sso.config_*`, `sso.connection_verified`, `sso.login`, `sso.login_failed{reason}`, `sso.jit_provisioned`, `sso.identity_unlinked`, `sso.state_changed`; `leadflow_sso_logins_total{result}`.
* Rate limit: 40 requests/min/IP on `/api/auth/sso/*`.

## SSO-only mode and recovery
"Require single sign-on" makes the workspace reject password sessions with `403 SSO_REQUIRED` (the web app then redirects to the IdP). **Owners keep password access** (break-glass). Recovery paths: (1) an owner switches SSO off or removes the connection; (2) a platform administrator (`SUPER_ADMIN`/`SUPPORT_ADMIN`) calls `POST /api/platform/organizations/:id/sso/disable` (audited); (3) database last resort: `UPDATE sso_connections SET enabled=false, enforce_sso=false WHERE organization_id='…'; UPDATE organizations SET sso_enforced=false WHERE id='…';`. Logout ends the LeadFlow session only (no IdP single-logout).

## Provider setup
* **Microsoft Entra ID**: App registration → Redirect URI (Web) = callback URL → client secret *value*; issuer `https://login.microsoftonline.com/<tenant-id>/v2.0` (your tenant id; never `common`/`organizations`, whose issuer is templated). Entra does not send `email_verified` by default: add the optional claim, or — for your own single-tenant app only — tick "Accept unverified email".
* **Google Workspace**: OAuth client (Web application), redirect URI = callback URL; issuer `https://accounts.google.com`; set the consent screen to *Internal*; allowed domain = your Workspace domain. Google sends `email_verified`.
* **Generic OIDC** (Okta, Auth0, Keycloak…): confidential client, code flow + PKCE; issuer = base URL serving `/.well-known/openid-configuration`; use **Check issuer** in the UI.

## What was tested — and what was not
Tested against a **local mock OIDC provider** (`apps/api/test/mock-idp.ts`) with the real client library: discovery, PKCE (the provider verifies the S256 challenge), state/nonce, wrong issuer, wrong audience, expired token, wrong signature, `alg: none`, HS256 signed with the client secret, missing/wrong nonce, rejected code, denied authorization, forged/replayed/foreign callback, unverified e-mail, other domain, unknown/inactive/deactivated/platform users, identity mismatch and re-link, JIT on/off with role and seat limits, SSO-only enforcement, owner break-glass, platform disable, SSRF guard, secret encryption, password sign-in regression, browser flow end to end (Playwright).
**Not verified:** any real provider (Entra, Google, Okta…). Provider quirks (claim names, `email_verified` behaviour, discovery quirks, clock skew, group claims, logout) need a staging test with real credentials.
