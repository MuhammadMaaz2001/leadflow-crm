import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';
import { log } from './logger';

/**
 * Object storage for uploaded assets (workspace logos).
 *  STORAGE_PROVIDER=db  — development default: the validated image stays inline in PostgreSQL (`logo_data` = data URL).
 *  STORAGE_PROVIDER=s3  — any S3-compatible service (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi…): the bytes go to the bucket,
 *                         `logo_data` keeps only `storage:<key>`, and the API serves the object through an authenticated route,
 *                         so the bucket can stay PRIVATE (no public ACLs, no CDN URLs to leak).
 * Uploads are always validated by content first (see lib/upload.ts) — storage never trusts the client's MIME type.
 */
export interface ObjectStorage {
  name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export type S3Options = typeof config.s3;
export class S3Storage implements ObjectStorage {
  name = 's3';
  private client: S3Client;
  private bucket: string;
  constructor(o: S3Options = config.s3) {
    this.bucket = o.bucket!;
    this.client = new S3Client({
      region: o.region, endpoint: o.endpoint, forcePathStyle: o.forcePathStyle,
      credentials: o.accessKeyId && o.secretAccessKey ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } : undefined,
      maxAttempts: 3, requestHandler: { requestTimeout: 10_000, connectionTimeout: 5_000 } as never,
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, max-age=31536000, immutable' }));
  }
  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await r.Body!.transformToByteArray();
      return { body: Buffer.from(bytes), contentType: r.ContentType ?? 'application/octet-stream' };
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

let override: ObjectStorage | null = null;
let s3: S3Storage | null = null;
export const setObjectStorage = (s: ObjectStorage | null) => { override = s; };
export function getObjectStorage(): ObjectStorage | null {
  if (override) return override;
  if (config.storageProvider !== 's3') return null;
  return (s3 ??= new S3Storage());
}
export const storageStatus = () => ({ provider: getObjectStorage()?.name ?? 'db' });

const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const KEY_PREFIX = 'storage:';

/** Persists a (validated) logo data URL; returns the string to store in `organizations.logo_data`. */
export async function storeLogo(orgId: string, dataUrl: string | null, previous: string | null): Promise<string | null> {
  const st = getObjectStorage();
  if (!dataUrl) { await deleteStored(previous); return null; }
  if (!st) { await deleteStored(previous); return dataUrl; }
  const m = DATA_URL.exec(dataUrl)!;                       // callers validate with validateLogo() first
  const bytes = Buffer.from(m[2]!, 'base64');
  const key = `logos/${orgId}/${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${EXT[m[1]!]}`;
  if (previous !== `${KEY_PREFIX}${key}`) await st.put(key, bytes, `image/${m[1]}`);
  if (previous && previous !== `${KEY_PREFIX}${key}`) await deleteStored(previous);
  return `${KEY_PREFIX}${key}`;
}
async function deleteStored(stored: string | null) {
  const st = getObjectStorage();
  if (st && stored?.startsWith(KEY_PREFIX)) await st.delete(stored.slice(KEY_PREFIX.length)).catch((e) => log.warn('could not delete stored object', { error: (e as Error).message }));
}
/** What the API (and therefore the browser) sees: inline data URLs as-is, stored objects as an authenticated route URL. */
export function presentLogo(orgId: string, stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(KEY_PREFIX)) return stored;
  return `/api/organizations/${orgId}/logo?v=${createHash('sha256').update(stored).digest('hex').slice(0, 12)}`;
}
export const isOwnLogoUrl = (v: string | null | undefined) => !!v && /^\/api\/organizations\/[0-9a-f-]{36}\/logo(\?|$)/.test(v);
export async function readStoredLogo(stored: string | null | undefined) {
  const st = getObjectStorage();
  if (!stored?.startsWith(KEY_PREFIX) || !st) return null;
  return st.get(stored.slice(KEY_PREFIX.length));
}
