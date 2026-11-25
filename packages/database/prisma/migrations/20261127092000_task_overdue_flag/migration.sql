-- Tasks get a separate "overdue notified" marker (like follow-ups): the approaching-deadline reminder no longer hides the overdue notice. Additive.
ALTER TABLE tasks ADD COLUMN overdue_notified_at timestamptz;
UPDATE tasks SET overdue_notified_at = reminder_sent_at WHERE reminder_sent_at IS NOT NULL AND due_at IS NOT NULL AND due_at <= now();
