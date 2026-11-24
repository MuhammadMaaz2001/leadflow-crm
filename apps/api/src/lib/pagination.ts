import { z } from 'zod';

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};
export const paginate = (q: { page: number; pageSize: number }) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
export const pageMeta = (q: { page: number; pageSize: number }, total: number) => ({
  page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const splitCsv = (v: unknown) => (typeof v === 'string' ? (v === '' ? [] : v.split(',')) : v);
/** Comma list of UUIDs; `extra` literals (e.g. "unassigned", "me") are allowed. */
export const csvUuids = (...extra: string[]) => z.preprocess(splitCsv, z.array(z.string().refine((s) => UUID.test(s) || extra.includes(s), 'Invalid id')).max(50).optional());
/** Comma list restricted to a fixed set of values. */
export const csvEnum = (values: readonly string[]) => z.preprocess(splitCsv, z.array(z.string().refine((s) => values.includes(s), 'Invalid value')).max(20).optional());
export const csvList = z.preprocess((v) => (typeof v === 'string' ? (v === '' ? [] : v.split(',')) : v), z.array(z.string()).optional());
export const boolQuery = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());
