import { badRequest } from './errors';

/** Sum of uncompressed sizes declared in a ZIP's central directory (xlsx is a zip) — rejects zip bombs before parsing. */
export function zipUncompressedSize(buf: Buffer): number {
  const minEocd = 22;
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - 65_557); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw badRequest('This is not a valid Excel file.', undefined, 'UNSUPPORTED_FILE');
  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw badRequest('This is not a valid Excel file.', undefined, 'UNSUPPORTED_FILE');
    total += buf.readUInt32LE(off + 24);
    off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return total;
}

const MAX_UNCOMPRESSED = 60 * 1024 * 1024;

/** Validates uploads by content (magic bytes), not by file name or declared MIME type. */
export function assertSpreadsheet(file: { originalname: string; buffer: Buffer }): 'xlsx' | 'csv' {
  const name = file.originalname.toLowerCase();
  const b = file.buffer;
  if (!b.length) throw badRequest('The file is empty.', undefined, 'EMPTY_FILE');
  const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  if (name.endsWith('.xlsx')) {
    if (!isZip) throw badRequest('This file is not a real .xlsx workbook.', undefined, 'UNSUPPORTED_FILE');
    if (zipUncompressedSize(b) > MAX_UNCOMPRESSED) throw badRequest('This workbook expands to an unreasonable size and was rejected.', undefined, 'FILE_TOO_LARGE');
    return 'xlsx';
  }
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    if (isZip || b.subarray(0, 4096).includes(0)) throw badRequest('This file does not look like a CSV text file.', undefined, 'UNSUPPORTED_FILE');
    return 'csv';
  }
  throw badRequest('Unsupported file type. Upload a .csv or .xlsx file.', undefined, 'UNSUPPORTED_FILE');
}

const LOGO_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
/** Logos are stored inline: accept only small raster images whose bytes match their declared type (no SVG/HTML). */
export function validateLogo(data: string | null | undefined): string | null {
  if (!data) return null;
  const m = LOGO_RE.exec(data);
  if (!m) throw badRequest('Logo must be a PNG, JPEG, WebP or GIF image.', { fields: { logoData: 'Unsupported image' } }, 'INVALID_LOGO');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > 400_000) throw badRequest('Logo must be smaller than 400 KB.', { fields: { logoData: 'Too large' } }, 'INVALID_LOGO');
  const magic = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46], gif: [0x47, 0x49, 0x46] }[m[1] as 'png'];
  if (!magic.every((v, i) => bytes[i] === v)) throw badRequest('The image content does not match its type.', { fields: { logoData: 'Invalid image' } }, 'INVALID_LOGO');
  return data;
}
