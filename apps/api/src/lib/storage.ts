import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';
import { log } from './logger';
import { storageDuration, storageOps } from './metrics';
import { AppError } from './errors';

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
  /** Stream of an object (large files are never loaded into memory whole); falls back to `get` when an adapter has none. */
  getStream?(key: string): Promise<Readable | null>;
  /** Objects under a prefix (bounded). Used by the orphan sweeper. */
  list(prefix: string, limit?: number): Promise<Array<{ key: string; lastModified: Date }>>;
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
  async getStream(key: string) {
    try { const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); return r.Body as Readable; }
    catch (e) { if ((e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async list(prefix: string, limit = 5000) {
    const out: Array<{ key: string; lastModified: Date }> = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, limit - out.length) }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified ?? new Date() });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token && out.length < limit);
    return out;
  }
}

/**
 * Local-disk adapter for DEVELOPMENT and TESTS only (single machine, no replication). Production must use S3-compatible storage:
 * `getAttachmentStorage()` refuses to fall back to disk when NODE_ENV is production. Keys are validated and every resolved path must stay
 * inside the storage root, so a hostile key can never escape it.
 */
export class LocalDiskStorage implements ObjectStorage {
  name = 'local';
  private root: string;
  constructor(dir: string = config.localStorageDir) { this.root = path.resolve(dir); }
  private file(key: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(key) || key.includes('..')) throw new Error('invalid storage key');
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer, contentType: string) {
    const p = this.file(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body); await fs.writeFile(`${p}.type`, contentType);
  }
  async get(key: string) {
    try { const p = this.file(key); return { body: await fs.readFile(p), contentType: await fs.readFile(`${p}.type`, 'utf8').catch(() => 'application/octet-stream') }; }
    catch (e) { if ((e as { code?: string }).code === 'ENOENT') return null; throw e; }
  }
  async delete(key: string) { const p = this.file(key); await fs.rm(p, { force: true }); await fs.rm(`${p}.type`, { force: true }); }
  async getStream(key: string) { const p = this.file(key); try { await fs.access(p); } catch { return null; } return createReadStream(p); }
  async list(prefix: string, limit = 5000) {
    const out: Array<{ key: string; lastModified: Date }> = [];
    const base = path.resolve(this.root, prefix);
    if (!base.startsWith(this.root)) return out;
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith('.type')) out.push({ key: path.relative(this.root, full).split(path.sep).join('/'), lastModified: (await fs.stat(full)).mtime });
      }
    };
    await walk(base);
    return out;
  }
}

/** Counts and times every storage operation (success / error) without changing behaviour. */
const instrumented = new WeakMap<ObjectStorage, ObjectStorage>();
function instrument(s: ObjectStorage): ObjectStorage {
  const hit = instrumented.get(s); if (hit) return hit;
  const run = async <T,>(op: string, fn: () => Promise<T>): Promise<T> => {
    const end = storageDuration.startTimer({ op });
    try { const r = await fn(); storageOps.inc({ op, result: 'ok' }); return r; } catch (e) { storageOps.inc({ op, result: 'error' }); throw e; } finally { end(); }
  };
  const w: ObjectStorage = {
    name: s.name,
    put: (k, b, t) => run('put', () => s.put(k, b, t)), get: (k) => run('get', () => s.get(k)), delete: (k) => run('delete', () => s.delete(k)),
    list: (p, l) => run('list', () => s.list(p, l)), ...(s.getStream ? { getStream: (k: string) => run('get_stream', () => s.getStream!(k)) } : {}),
  };
  instrumented.set(s, w); return w;
}
let override: ObjectStorage | null = null;
let s3: S3Storage | null = null;
export const setObjectStorage = (s: ObjectStorage | null) => { override = s; };
export function getObjectStorage(): ObjectStorage | null {
  if (override) return instrument(override);
  if (config.storageProvider !== 's3') return null;
  return instrument((s3 ??= new S3Storage()));
}
let local: LocalDiskStorage | null = null;
/**
 * Storage for lead attachments (bytes never go to PostgreSQL): the S3 bucket when configured; local disk in development/test;
 * `null` in production without S3, in which case the attachment API answers 503 FEATURE_UNAVAILABLE instead of silently degrading.
 */
export function getAttachmentStorage(): ObjectStorage | null {
  const s = getObjectStorage();
  if (s) return s;
  if (config.isProd) return null;
  return instrument((local ??= new LocalDiskStorage()));
}
/** Private storage for non-public working files (import sources). Same adapter and rules as attachments. */
export const getPrivateStorage = getAttachmentStorage;
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
  if (previous !== `${KEY_PREFIX}${key}`) {
    try { await st.put(key, bytes, `image/${m[1]}`); }
    catch (e) { log.error('object storage upload failed', { error: (e as Error).message }); throw new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Nothing was changed; please try again in a moment.'); }
  }
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
  try { return await st.get(stored.slice(KEY_PREFIX.length)); }
  catch (e) { log.error('object storage read failed', { error: (e as Error).message }); throw new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable.'); }
}
