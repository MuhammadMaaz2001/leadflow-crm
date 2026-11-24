import { z } from 'zod';

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};
export const paginate = (q: { page: number; pageSize: number }) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
export const pageMeta = (q: { page: number; pageSize: number }, total: number) => ({
  page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
});
export const csvList = z.preprocess((v) => (typeof v === 'string' ? (v === '' ? [] : v.split(',')) : v), z.array(z.string()).optional());
export const boolQuery = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());
