-- Email outbox: delivery state is tracked honestly (QUEUED → SENT | FAILED | UNDELIVERABLE). Additive only.
ALTER TABLE outbound_emails
  ADD COLUMN status text NOT NULL DEFAULT 'SENT',
  ADD COLUMN provider text,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN message_id text;

-- rows written before this migration were delivered to the development mailbox
UPDATE outbound_emails SET provider = 'dev', sent_at = created_at;

ALTER TABLE outbound_emails ALTER COLUMN status SET DEFAULT 'QUEUED';
ALTER TABLE outbound_emails ADD CONSTRAINT outbound_emails_status_check CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'UNDELIVERABLE'));
ALTER TABLE outbound_emails ADD CONSTRAINT outbound_emails_sent_has_timestamp CHECK (status <> 'SENT' OR sent_at IS NOT NULL);
CREATE INDEX outbound_emails_pending_idx ON outbound_emails (created_at) WHERE status IN ('QUEUED', 'FAILED');
