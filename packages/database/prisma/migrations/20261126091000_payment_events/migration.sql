-- Idempotency ledger for payment-provider events (webhooks). Additive; no provider is wired up yet.
CREATE TABLE payment_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text        NOT NULL,
  event_id    text        NOT NULL,
  event_type  text        NOT NULL,
  invoice_id  uuid        REFERENCES invoices (id) ON DELETE SET NULL,
  outcome     text        NOT NULL CHECK (outcome IN ('APPLIED', 'REJECTED', 'IGNORED')),
  detail      text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_provider_event_unique UNIQUE (provider, event_id)
);
CREATE INDEX payment_events_invoice_idx ON payment_events (invoice_id);
GRANT SELECT, INSERT, UPDATE ON payment_events TO leadflow_platform;
