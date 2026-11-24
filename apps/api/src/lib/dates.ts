import { addDays, addMonths, startOfMonth, startOfQuarter, startOfWeek, subDays } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { z } from 'zod';

export const RANGE_PRESETS = ['today', 'yesterday', 'this_week', 'last_7_days', 'last_30_days', 'this_month', 'last_month', 'this_quarter', 'this_year', 'all', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const rangeQuery = {
  range: z.enum(RANGE_PRESETS).default('last_30_days'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

export interface Range { from: Date; to: Date; preset: RangePreset }

const startOfLocalDay = (d: Date, tz: string) => { const z = toZonedTime(d, tz); z.setHours(0, 0, 0, 0); return fromZonedTime(z, tz); };

/** Half-open [from, to) range for a preset, evaluated in the workspace timezone. */
export function resolveRange(preset: RangePreset, tz: string, custom?: { from?: Date; to?: Date }, now = new Date()): Range {
  const todayStart = startOfLocalDay(now, tz);
  const local = (fn: (z: Date) => Date) => fromZonedTime(fn(toZonedTime(now, tz)), tz);
  switch (preset) {
    case 'today': return { preset, from: todayStart, to: addDaysTz(todayStart, 1, tz) };
    case 'yesterday': return { preset, from: addDaysTz(todayStart, -1, tz), to: todayStart };
    case 'this_week': { const s = local((z) => { const w = startOfWeek(z, { weekStartsOn: 1 }); w.setHours(0, 0, 0, 0); return w; }); return { preset, from: s, to: addDaysTz(s, 7, tz) }; }
    case 'last_7_days': return { preset, from: addDaysTz(todayStart, -6, tz), to: addDaysTz(todayStart, 1, tz) };
    case 'last_30_days': return { preset, from: addDaysTz(todayStart, -29, tz), to: addDaysTz(todayStart, 1, tz) };
    case 'this_month': { const s = local((z) => startOfMonth(z)); return { preset, from: s, to: local((z) => addMonths(startOfMonth(z), 1)) }; }
    case 'last_month': return { preset, from: local((z) => addMonths(startOfMonth(z), -1)), to: local((z) => startOfMonth(z)) };
    case 'this_quarter': return { preset, from: local((z) => startOfQuarter(z)), to: local((z) => addMonths(startOfQuarter(z), 3)) };
    case 'this_year': return { preset, from: local((z) => new Date(z.getFullYear(), 0, 1)), to: local((z) => new Date(z.getFullYear() + 1, 0, 1)) };
    case 'all': return { preset, from: new Date('2000-01-01T00:00:00Z'), to: addDays(now, 3650) };
    case 'custom': {
      const f = custom?.from ? startOfLocalDay(custom.from, tz) : subDays(todayStart, 29);
      const t = custom?.to ? addDaysTz(startOfLocalDay(custom.to, tz), 1, tz) : addDaysTz(todayStart, 1, tz);
      return { preset, from: f, to: t > f ? t : addDaysTz(f, 1, tz) };
    }
  }
}
function addDaysTz(d: Date, n: number, tz: string) {
  const z = toZonedTime(d, tz); z.setDate(z.getDate() + n); return fromZonedTime(z, tz);
}
export const todayRange = (tz: string) => resolveRange('today', tz);
