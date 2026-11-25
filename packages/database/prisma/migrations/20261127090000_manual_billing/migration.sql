-- Manual billing: confirmed payments (receipts) with the subscription period they extended. Additive only.
-- Writes are reserved to the platform role: the tenant (application) role can only READ its own payments, enforced three ways:
-- (1) no INSERT/UPDATE/DELETE grant, (2) RLS policy for SELECT only, (3) triggers below that stop it from touching paid status / expiry.

ALTER TABLE invoices ADD CONSTRAINT invoices_id_org_unique UNIQUE (id, organization_id);

CREATE TABLE payments (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid          NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  invoice_id             uuid,
  invoice_generated      boolean       NOT NULL DEFAULT false,
  receipt_number         text          NOT NULL UNIQUE,
  status                 text          NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'REVERSED')),
  amount                 numeric(12,2) NOT NULL CHECK (amount > 0),
  currency               text          NOT NULL,
  method                 text          NOT NULL CHECK (method IN ('BANK_TRANSFER', 'CASH', 'CARD_OFFLINE', 'CHEQUE', 'MOBILE_MONEY', 'OTHER')),
  reference              text          NOT NULL CHECK (length(btrim(reference)) > 0),
  received_at            timestamptz   NOT NULL,
  plan_id                uuid          REFERENCES subscription_plans (id),
  extension_months       integer       CHECK (extension_months IS NULL OR extension_months > 0),
  extension_days         integer       CHECK (extension_days IS NULL OR extension_days > 0),
  previous_status        text,
  previous_plan_id       uuid,
  previous_period_start  timestamptz,
  previous_period_end    timestamptz,
  previous_grace_ends_at timestamptz,
  previous_trial_ends_at timestamptz,
  new_period_start       timestamptz   NOT NULL,
  new_period_end         timestamptz   NOT NULL,
  extension_base         text          NOT NULL,
  note                   text,
  internal_note          text,
  recorded_by_id         uuid          NOT NULL,
  idempotency_key        text          UNIQUE,
  reversed_at            timestamptz,
  reversed_by_id         uuid,
  reversal_reason        text,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices (id, organization_id),
  CONSTRAINT payments_period_order CHECK (new_period_end > new_period_start),
  CONSTRAINT payments_reversal_complete CHECK (status <> 'REVERSED' OR (reversed_at IS NOT NULL AND reversed_by_id IS NOT NULL AND reversal_reason IS NOT NULL))
);
-- the same reference can be confirmed once per workspace while it is valid (prevents double extension from a repeated entry)
CREATE UNIQUE INDEX payments_org_reference_unique ON payments (organization_id, lower(btrim(reference))) WHERE status = 'CONFIRMED';
CREATE INDEX payments_org_received_idx ON payments (organization_id, received_at DESC);
CREATE INDEX payments_invoice_idx ON payments (invoice_id, organization_id);
CREATE INDEX payments_plan_idx ON payments (plan_id);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON payments FOR SELECT USING (organization_id = app_org_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON payments FROM leadflow_app;
GRANT SELECT, INSERT, UPDATE ON payments TO leadflow_platform;

-- ── Defence in depth: the tenant role can never mark an invoice paid or lengthen a paid subscription ──
CREATE OR REPLACE FUNCTION guard_invoice_paid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'leadflow_app' AND NEW.status = 'PAID' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'PAID') THEN
    RAISE EXCEPTION 'invoices can only be marked paid by platform billing' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_paid_guard BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_paid();

CREATE OR REPLACE FUNCTION guard_subscription_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE new_free boolean; new_price numeric; old_price numeric;
BEGIN
  IF current_user <> 'leadflow_app' THEN RETURN NEW; END IF;
  SELECT (code = 'free'), price_monthly INTO new_free, new_price FROM subscription_plans WHERE id = NEW.plan_id;
  SELECT price_monthly INTO old_price FROM subscription_plans WHERE id = OLD.plan_id;
  IF NOT COALESCE(new_free, false) THEN
    IF NEW.current_period_end > OLD.current_period_end THEN
      RAISE EXCEPTION 'subscription expiry can only be extended by platform billing' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'ACTIVE' AND OLD.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a paid subscription can only be activated by platform billing' USING ERRCODE = '42501';
    END IF;
    IF NEW.plan_id <> OLD.plan_id AND new_price > COALESCE(old_price, 0) THEN
      RAISE EXCEPTION 'upgrades are applied by platform billing after payment' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_change_guard BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION guard_subscription_changes();
