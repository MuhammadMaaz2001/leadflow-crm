import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const uuid = () => crypto.randomUUID();
