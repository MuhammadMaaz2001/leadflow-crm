export const fullNameOf = (l: { firstName?: string | null; lastName?: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(' ');

export const STATUS_META: Record<string, { label: string; tone: 'neutral' | 'info' | 'accent' | 'ok' | 'bad' | 'warn' }> = {
  NEW: { label: 'New', tone: 'neutral' }, CONTACTED: { label: 'Contacted', tone: 'info' }, QUALIFIED: { label: 'Qualified', tone: 'accent' },
  CONVERTED: { label: 'Won', tone: 'ok' }, LOST: { label: 'Lost', tone: 'bad' },
};
export const TASK_STATUS_META: Record<string, { label: string; tone: 'neutral' | 'info' | 'ok' | 'bad' }> = {
  TODO: { label: 'To do', tone: 'neutral' }, IN_PROGRESS: { label: 'In progress', tone: 'info' }, DONE: { label: 'Done', tone: 'ok' }, CANCELED: { label: 'Canceled', tone: 'bad' },
};
export const PRIORITY_TONE: Record<string, 'neutral' | 'warn' | 'bad'> = { LOW: 'neutral', MEDIUM: 'warn', HIGH: 'bad' };
