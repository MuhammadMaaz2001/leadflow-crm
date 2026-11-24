export function normalizeEmail(email?: string | null): string | null {
  const v = email?.trim().toLowerCase();
  return v ? v : null;
}

/** Digits only; for numbers longer than 10 digits the last 10 are kept (national significant number). */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, '');
  if (digits.length < 5) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function fullName(l: { firstName?: string | null; lastName?: string | null }): string {
  return [l.firstName, l.lastName].filter(Boolean).join(' ').trim();
}

export function slugify(input: string): string {
  return input.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
}
