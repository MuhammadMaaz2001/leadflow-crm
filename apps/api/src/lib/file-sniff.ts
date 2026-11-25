import { zipUncompressedSize } from './upload';
import { badRequest, AppError } from './errors';

/**
 * Content-based validation of attachment uploads. The file NAME and the browser-declared MIME type are never trusted:
 * the bytes must match one of the allowed formats, the extension must agree with them, and the stored extension / content type are
 * derived from the DETECTED format (not from what the client claimed).
 */
export type Kind = 'pdf' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'csv' | 'jpg' | 'png' | 'webp';
export interface Detected { kind: Kind; extension: Kind; contentType: string }

const TYPES: Record<Kind, { mime: string; accepts: string[] }> = {
  pdf: { mime: 'application/pdf', accepts: ['application/pdf', 'application/x-pdf'] },
  doc: { mime: 'application/msword', accepts: ['application/msword', 'application/vnd.ms-office'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', accepts: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  xls: { mime: 'application/vnd.ms-excel', accepts: ['application/vnd.ms-excel', 'application/vnd.ms-office'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', accepts: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  csv: { mime: 'text/csv', accepts: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'text/x-csv'] },
  jpg: { mime: 'image/jpeg', accepts: ['image/jpeg', 'image/pjpeg'] },
  png: { mime: 'image/png', accepts: ['image/png'] },
  webp: { mime: 'image/webp', accepts: ['image/webp'] },
};
export const ATTACHMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'jpg', 'jpeg', 'png', 'webp'] as const;
export const ATTACHMENT_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.webp';
const EXT_TO_KIND: Record<string, Kind> = { pdf: 'pdf', doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx', csv: 'csv', jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp' };
const reject = (msg: string, code = 'UNSUPPORTED_FILE') => new AppError(415, code, msg);

/** Names of the entries of a ZIP container (central directory). Bounded, and never extracts anything. */
export function zipEntryNames(buf: Buffer): string[] {
  const min = 22;
  let eocd = -1;
  for (let i = buf.length - min; i >= Math.max(0, buf.length - 65_557); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return [];
  const entries = Math.min(buf.readUInt16LE(eocd + 10), 10_000);
  let off = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < entries; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return names;
    const n = buf.readUInt16LE(off + 28);
    names.push(buf.subarray(off + 46, off + 46 + n).toString('utf8'));
    off += 46 + n + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return names;
}

function sniff(b: Buffer): 'pdf' | 'ole2' | 'zip' | 'jpg' | 'png' | 'webp' | 'exe' | 'text' | 'binary' {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole2';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) return 'zip';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if ((b[0] === 0x4d && b[1] === 0x5a) || (b[0] === 0x7f && b.subarray(1, 4).toString('latin1') === 'ELF') || (b[0] === 0x23 && b[1] === 0x21) || (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe)) return 'exe';
  const head = b.subarray(0, 65_536);
  if (head.includes(0)) return 'binary';
  for (const c of head) if (c < 9 || (c > 13 && c < 32 && c !== 27)) return 'binary';
  return 'text';
}

/** Throws a 415 (or 400) with a precise reason, otherwise returns the canonical type derived from the bytes. */
export function detectAttachment(file: { originalname: string; buffer: Buffer; mimetype?: string }): Detected {
  const b = file.buffer;
  if (!b?.length) throw badRequest('The file is empty.', undefined, 'EMPTY_FILE');
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(file.originalname.trim())?.[1]?.toLowerCase();
  const wanted = ext ? EXT_TO_KIND[ext] : undefined;
  if (!wanted) throw reject(`Unsupported file type. Allowed: ${ATTACHMENT_EXTENSIONS.join(', ').toUpperCase()}.`);
  const found = sniff(b);
  if (found === 'exe') throw reject('Executable files and scripts are not allowed.', 'FORBIDDEN_FILE');
  let kind: Kind;
  if (found === 'zip') {
    const names = zipEntryNames(b);
    if (zipUncompressedSize(b) > 250 * 1024 * 1024) throw badRequest('This file expands to an unreasonable size and was rejected.', undefined, 'FILE_TOO_LARGE');
    if (names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n) || n.includes('..'))) throw reject('Files containing macros or unsafe paths are not allowed.', 'FORBIDDEN_FILE');
    if (!names.includes('[Content_Types].xml')) throw reject('This archive is not an Office document.');
    kind = names.some((n) => n.startsWith('word/')) ? 'docx' : names.some((n) => n.startsWith('xl/')) ? 'xlsx' : (undefined as never);
    if (!kind) throw reject('This archive is not a Word or Excel document.');
  } else if (found === 'ole2') {
    if (wanted !== 'doc' && wanted !== 'xls') throw reject('The file content does not match its extension.', 'CONTENT_MISMATCH');
    kind = wanted;
  } else if (found === 'text') {
    if (/^\s*</.test(b.subarray(0, 512).toString('utf8'))) throw reject('Markup files are not allowed.', 'FORBIDDEN_FILE');
    kind = 'csv';
  } else if (found === 'binary') throw reject('The file content is not a supported format.');
  else kind = found;
  if (EXT_TO_KIND[ext!] !== kind) throw reject(`The file content is ${kind.toUpperCase()}, but its name says .${ext}. Rename it or upload the correct file.`, 'CONTENT_MISMATCH');
  const declared = (file.mimetype ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && !TYPES[kind].accepts.includes(declared)) throw reject('The declared file type does not match the file content.', 'CONTENT_MISMATCH');
  return { kind, extension: kind, contentType: TYPES[kind].mime };
}

/** A display-safe file name: no path components, control or bidi-override characters, bounded length. */
export function safeFileName(raw: string): string {
  let n = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (n.length > 150) { const m = /(\.[A-Za-z0-9]{1,8})$/.exec(n); n = n.slice(0, 150 - (m?.[1].length ?? 0)) + (m?.[1] ?? ''); }
  return n || 'file';
}
export const contentDisposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, escape)}`;
