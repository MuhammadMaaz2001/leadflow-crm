import { format, formatDistanceToNowStrict, isToday, isTomorrow, isYesterday } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

export const initials = (name?: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

export function money(value: number | string | null | undefined, currency = 'USD', compact = false) {
  const n = Number(value ?? 0);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: compact || Math.abs(n) >= 1000 ? 0 : 2, notation: compact && Math.abs(n) >= 100000 ? 'compact' : 'standard' }).format(n);
  } catch { return `${currency} ${n.toLocaleString()}`; }
}
export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

let fmtPattern = 'MMM d, yyyy';
let tz: string | undefined;
export function setFormatPrefs(p: { dateFormat?: string; timezone?: string }) { if (p.dateFormat) fmtPattern = p.dateFormat; tz = p.timezone; }

const safe = (d: string | Date | null | undefined) => { if (!d) return null; const x = new Date(d); return Number.isNaN(x.getTime()) ? null : x; };
export function fmtDate(d: string | Date | null | undefined, pattern?: string) {
  const x = safe(d); if (!x) return '—';
  try { return tz ? formatInTimeZone(x, tz, pattern ?? fmtPattern) : format(x, pattern ?? fmtPattern); } catch { return format(x, pattern ?? fmtPattern); }
}
export function fmtDateTime(d: string | Date | null | undefined) {
  const x = safe(d); if (!x) return '—';
  return `${fmtDate(x)} · ${fmtDate(x, 'h:mm a')}`;
}
export function fmtRelativeDay(d: string | Date | null | undefined) {
  const x = safe(d); if (!x) return '—';
  const t = fmtDate(x, 'h:mm a');
  if (isToday(x)) return `Today, ${t}`;
  if (isTomorrow(x)) return `Tomorrow, ${t}`;
  if (isYesterday(x)) return `Yesterday, ${t}`;
  return `${fmtDate(x, x.getFullYear() === new Date().getFullYear() ? 'MMM d' : undefined)}, ${t}`;
}
export function timeAgo(d: string | Date | null | undefined) {
  const x = safe(d); if (!x) return '—';
  const s = formatDistanceToNowStrict(x, { addSuffix: true });
  return s.replace(' seconds', 's').replace(' second', 's').replace(' minutes', 'm').replace(' minute', 'm').replace(' hours', 'h').replace(' hour', 'h').replace(' days', 'd').replace(' day', 'd');
}
export function dueLabel(d: string | Date) {
  const x = safe(d)!; const diff = x.getTime() - Date.now();
  if (diff < 0) return `${formatDistanceToNowStrict(x)} overdue`;
  return `in ${formatDistanceToNowStrict(x)}`;
}
/** value for <input type="datetime-local"> in the viewer's local zone */
export const toLocalInput = (d: Date | string) => format(new Date(d), "yyyy-MM-dd'T'HH:mm");
export const fromLocalInput = (v: string) => new Date(v).toISOString();
export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const pct = (n: number | null | undefined) => `${(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

/** IANA zones for pickers. `Intl.supportedValuesOf` omits "UTC" (the platform default), so it is added explicitly. */
export const TIMEZONES: string[] = (() => {
  let zones: string[];
  try { zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone'); } catch { zones = ['America/New_York', 'Europe/London', 'Asia/Karachi', 'Asia/Dubai']; }
  return ['UTC', ...zones.filter((z) => z !== 'UTC')];
})();
export const withCurrent = (list: string[], current?: string | null) => (current && !list.includes(current) ? [current, ...list] : list);
