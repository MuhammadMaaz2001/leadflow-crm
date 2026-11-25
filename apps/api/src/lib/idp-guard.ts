import dns from 'node:dns';
import net from 'node:net';
import { custom } from 'openid-client';
import { config } from '../config';

/**
 * SSRF protection for every request the server makes to an identity provider (discovery, JWKS, token endpoint).
 * The workspace admin supplies the issuer URL, so in production the connection is refused when the host resolves to a private,
 * loopback, link-local or metadata address. The check happens in the socket's own DNS lookup (not before it), so a DNS-rebinding
 * answer cannot swap in an internal address between "check" and "connect". Timeouts and no-retry keep a hostile endpoint from tying up workers.
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}
export const allowPrivateIdp = () => config.ssoAllowPrivateIdp;

type Cb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
export function guardedLookup(hostname: string, options: dns.LookupOptions | number | Cb, cb?: Cb) {
  const opts = typeof options === 'function' ? {} : typeof options === 'number' ? { family: options } : options;
  const done = (typeof options === 'function' ? options : cb) as Cb;
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return done(err);
    const list = addrs as dns.LookupAddress[];
    if (!allowPrivateIdp() && list.some((a) => isPrivateAddress(a.address))) {
      const e = new Error(`The identity provider host "${hostname}" resolves to a private or internal address, which is not allowed.`) as NodeJS.ErrnoException; e.code = 'EIDPPRIVATE'; return done(e);
    }
    if ((opts as { all?: boolean }).all) return done(null, list);
    done(null, list[0]!.address, list[0]!.family);
  });
}
let installed = false;
export function installIdpGuard() {
  if (installed) return; installed = true;
  custom.setHttpOptionsDefaults({ timeout: 8000, retry: 0, lookup: guardedLookup } as never);
}
/** A syntactically acceptable issuer URL: https (http only for localhost in development/test), no credentials, no fragment. */
export function validateIssuerUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'The issuer must be a valid URL.'; }
  if (u.username || u.password) return 'The issuer URL must not contain credentials.';
  if (u.hash || u.search) return 'The issuer URL must not contain a query string or fragment.';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !config.isProd)) return 'The issuer must use https.';
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, '')) && !allowPrivateIdp()) return 'The issuer must not be an internal IP address.';
  return null;
}
