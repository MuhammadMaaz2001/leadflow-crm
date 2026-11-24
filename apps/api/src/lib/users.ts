import { db } from '../db';

export interface UserLite { id: string; name: string; email: string }

/** Resolve display info for user ids referenced by tenant rows. */
export async function usersById(ids: Array<string | null | undefined>): Promise<Map<string, UserLite>> {
  const uniq = [...new Set(ids.filter((i): i is string => !!i))];
  if (!uniq.length) return new Map();
  const rows = await db().user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true, email: true } });
  return new Map(rows.map((r) => [r.id, r]));
}
export const lite = (m: Map<string, UserLite>, id?: string | null) => (id ? m.get(id) ?? { id, name: 'Unknown user', email: '' } : null);
