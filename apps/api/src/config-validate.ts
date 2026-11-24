/**
 * Production environment validation. Pure function (takes the environment as a parameter) so it can be unit tested,
 * run by `npm run check:config` before a deploy, and enforced at API / worker start-up when NODE_ENV=production.
 */
export interface ConfigReport { errors: string[]; warnings: string[] }

const DEV_SECRETS = ['leadflow_dev', 'leadflow_app_dev', 'leadflow_platform_dev', 'Admin#Pass2026', 'Demo#Pass2026'];
const isLocal = (host: string) => /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/.test(host);

function parseUrl(v: string | undefined) { try { return v ? new URL(v) : null; } catch { return null; } }

export function validateProductionConfig(env: Record<string, string | undefined>): ConfigReport {
  const errors: string[] = []; const warnings: string[] = [];
  const err = (m: string) => errors.push(m); const warn = (m: string) => warnings.push(m);

  if (env.NODE_ENV !== 'production') err('NODE_ENV must be exactly "production" (anything else enables the fail-safe production mode implicitly, but deployments must say so explicitly).');
  if (env.ALLOW_DEV_TOOLS === 'true') err('ALLOW_DEV_TOOLS=true must not be set in production.');
  if (env.DISABLE_RATE_LIMIT === 'true') err('DISABLE_RATE_LIMIT=true must not be set in production.');
  if (env.JOBS_INLINE === 'true') err('JOBS_INLINE=true runs jobs inside API requests; production must use the separate worker process (JOBS_INLINE=false).');
  if (env.RATE_LIMIT_STORE === 'memory') warn('RATE_LIMIT_STORE=memory: limits are per process and not shared between API instances.');

  // database
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL'] as const) {
    const u = parseUrl(env[name]);
    if (!env[name]) { if (name !== 'DATABASE_URL') err(`${name} is required (restricted runtime role); falling back to the owner connection would bypass row level security.`); continue; }
    if (!u) { err(`${name} is not a valid URL.`); continue; }
    if (DEV_SECRETS.some((d) => decodeURIComponent(u.password) === d)) err(`${name} uses a development password.`);
    if (!isLocal(u.hostname) && !/sslmode=(require|verify-ca|verify-full)/.test(u.search)) warn(`${name} connects to a remote host without sslmode=require (or stronger).`);
  }
  const app = parseUrl(env.APP_DATABASE_URL), plat = parseUrl(env.PLATFORM_DATABASE_URL), owner = parseUrl(env.DATABASE_URL);
  if (app && owner && app.username === owner.username) err('APP_DATABASE_URL must use the restricted runtime role, not the owner/migration role (row level security would not apply).');
  if (app && plat && app.username === plat.username) err('APP_DATABASE_URL and PLATFORM_DATABASE_URL must use different roles.');
  for (const n of ['APP_DB_PASSWORD', 'PLATFORM_DB_PASSWORD']) if (env[n] && DEV_SECRETS.includes(env[n]!)) err(`${n} is a development password.`);

  // redis
  const redis = parseUrl(env.REDIS_URL);
  if (!redis) err('REDIS_URL is required (rate limiting, scheduler locks, job queue).');
  else {
    if (isLocal(redis.hostname)) warn('REDIS_URL points at localhost; production should use a managed Redis.');
    if (!isLocal(redis.hostname) && redis.protocol !== 'rediss:') warn('REDIS_URL does not use TLS (rediss://).');
  }

  // urls & origins
  const web = (env.WEB_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (web.length === 0) err('WEB_URL is required (allowed browser origin(s), comma separated).');
  for (const w of web) { const u = parseUrl(w); if (!u) err(`WEB_URL entry "${w}" is not a URL.`); else if (u.protocol !== 'https:') err(`WEB_URL entry "${w}" must use https.`); else if (u.pathname !== '/' || u.search) err(`WEB_URL entry "${w}" must be an origin without path.`); }
  const api = parseUrl(env.API_URL);
  if (!api) err('API_URL is required.'); else if (api.protocol !== 'https:' && !isLocal(api.hostname)) warn('API_URL is not https; if the web app proxies to the API over a private network this is acceptable.');

  // providers
  const email = env.EMAIL_TRANSPORT ?? 'dev';
  if (email === 'dev') err('EMAIL_TRANSPORT=dev stores mail in the database and never delivers it. Use EMAIL_TRANSPORT=smtp (or "none" to run knowingly without email).');
  else if (email === 'none') warn('EMAIL_TRANSPORT=none: no email is delivered (verification, invitation and reset emails stay undelivered and are reported as such).');
  else if (email === 'smtp') {
    if (!env.SMTP_HOST) err('SMTP_HOST is required for EMAIL_TRANSPORT=smtp.');
    if (!env.EMAIL_FROM || /localhost/.test(env.EMAIL_FROM)) err('EMAIL_FROM must be a real sender address for EMAIL_TRANSPORT=smtp.');
    if (env.SMTP_USER && !env.SMTP_PASSWORD) err('SMTP_PASSWORD is required when SMTP_USER is set.');
  } else err(`EMAIL_TRANSPORT="${email}" is not supported (dev | smtp | none).`);

  const storage = env.STORAGE_PROVIDER ?? 'db';
  if (storage === 's3') { for (const n of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) if (!env[n]) err(`${n} is required for STORAGE_PROVIDER=s3.`); }
  else if (storage === 'db') warn('STORAGE_PROVIDER=db keeps uploaded logos as base64 in PostgreSQL; use s3 for object storage.');
  else err(`STORAGE_PROVIDER="${storage}" is not supported (db | s3).`);

  const pay = env.PAYMENT_PROVIDER ?? 'manual';
  if (pay !== 'manual') err(`PAYMENT_PROVIDER="${pay}" has no adapter installed; only "manual" exists (invoices are paid by recording a payment).`);
  else warn('PAYMENT_PROVIDER=manual: no card processing; payments are recorded by a platform administrator.');

  if (!env.SESSION_COOKIE_NAME) warn('SESSION_COOKIE_NAME not set; default "lf_session" is used.');
  return { errors, warnings };
}
