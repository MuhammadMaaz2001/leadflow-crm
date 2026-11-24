import { describe, expect, it } from 'vitest';
import { fmtDate, initials, money, pct, titleCase, toLocalInput } from '@/lib/format';
import { qs } from '@/lib/api';
import { leadSchema, followUpCompleteSchema, normalizePhone, normalizeEmail } from '@leadflow/shared';

describe('formatters', () => {
  it('formats money, percentages and names', () => {
    expect(money(1250.5, 'USD')).toBe('$1,251');
    expect(money(250, 'USD')).toBe('$250.00');
    expect(pct(36.36)).toBe('36.4%');
    expect(initials('Olivia Owens')).toBe('OO');
    expect(titleCase('CALLBACK_REQUESTED')).toBe('Callback Requested');
  });
  it('formats dates safely', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate('not a date')).toBe('—');
    expect(fmtDate('2026-03-05T12:00:00Z', 'yyyy-MM-dd')).toMatch(/2026-03-0[45]/);
    expect(toLocalInput(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02T03:04');
  });
  it('builds query strings skipping empty values', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: ['x', 'y'], e: false })).toBe('?a=1&d=x%2Cy&e=false');
  });
});

describe('shared validation used by the forms', () => {
  it('requires first name and a contact method for leads', () => {
    expect(leadSchema.safeParse({ firstName: 'A' }).success).toBe(false);
    expect(leadSchema.safeParse({ firstName: 'A', email: 'a@b.co' }).success).toBe(true);
    expect(leadSchema.safeParse({ firstName: 'A', phone: '+1 415 555 0100' }).success).toBe(true);
    expect(leadSchema.safeParse({ firstName: 'A', email: 'bad' }).success).toBe(false);
    expect(leadSchema.safeParse({ firstName: '', email: 'a@b.co' }).success).toBe(false);
  });
  it('requires an outcome to complete a follow-up', () => {
    expect(followUpCompleteSchema.safeParse({}).success).toBe(false);
    expect(followUpCompleteSchema.safeParse({ outcome: 'INTERESTED' }).success).toBe(true);
  });
  it('normalises email and phone consistently for duplicate detection', () => {
    expect(normalizeEmail('  Ann@X.com ')).toBe('ann@x.com');
    expect(normalizePhone('+1 (415) 555-0100')).toBe(normalizePhone('415.555.0100'));
    expect(normalizePhone('12')).toBeNull();
  });
});
