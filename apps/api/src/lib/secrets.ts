import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config';
import { AppError } from './errors';

/**
 * Encryption of integration secrets stored in the database (SSO client secrets). AES-256-GCM, random 96-bit nonce per value, and the
 * workspace id is bound as additional authenticated data: a ciphertext copied into another workspace's row cannot be decrypted.
 *  • SSO_ENCRYPTION_KEY = 32 random bytes, base64 (generate: `openssl rand -base64 32`), from the secret manager — never committed.
 *  • Development / tests fall back to a fixed, public key so the feature works out of the box; production refuses to store a secret without a real key.
 *  • Rotation: ciphertexts carry a version prefix (`v1.`); re-save the connection after changing the key (the admin UI shows "re-enter the client secret").
 */
const DEV_KEY = Buffer.alloc(32, 'leadflow-development-only-sso-key-0');
function key(): Buffer {
  const raw = process.env.SSO_ENCRYPTION_KEY;
  if (!raw) {
    if (config.isProd) throw new AppError(503, 'SSO_NOT_CONFIGURED', 'Single sign-on is not available: the server has no SSO_ENCRYPTION_KEY configured.');
    return DEV_KEY;
  }
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new AppError(503, 'SSO_NOT_CONFIGURED', 'SSO_ENCRYPTION_KEY must be 32 random bytes encoded as base64.');
  return k;
}
export const ssoEncryptionAvailable = () => { try { key(); return true; } catch { return false; } };

export function encryptSecret(plain: string, orgId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(orgId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
export function decryptSecret(enc: string, orgId: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new AppError(500, 'SSO_SECRET_UNREADABLE', 'The stored client secret cannot be read. Re-enter it in the SSO settings.');
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(orgId)); d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { throw new AppError(500, 'SSO_SECRET_UNREADABLE', 'The stored client secret cannot be read (wrong key?). Re-enter it in the SSO settings.'); }
}
