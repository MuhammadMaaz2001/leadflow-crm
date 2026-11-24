import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
// Native bcrypt runs on the libuv thread pool, so password hashing never blocks the event loop (pure-JS bcryptjs did, and capped
// login throughput at ~12/s per process). Hashes are format-compatible with bcryptjs, so existing users keep working.
export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const uuid = () => crypto.randomUUID();
