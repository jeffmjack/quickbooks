-- ============================================================
-- Ramp payment notifications
--
-- Ramp emails billing@ for AR (customer paid us) and AP (we paid vendor)
-- events. This table stages only AR `payment delivered` events for now —
-- those become QBO Receive Payments deposited to Undeposited Funds.
--
-- One row per Ramp Payment ID (UNIQUE). Ramp re-sends the same event with
-- different Gmail message IDs occasionally, so DB-side idempotency is by
-- ramp_payment_id, not email_message_id.
-- ============================================================

CREATE TABLE ramp_payments (
    id                       SERIAL PRIMARY KEY,
    ramp_payment_id          TEXT UNIQUE NOT NULL,   -- e.g. WWM2ZMWMSL — Ramp's stable id
    direction                TEXT NOT NULL,           -- 'ar' (handled) | 'ap' (logged, future)
    event_type               TEXT NOT NULL,           -- 'initiated' | 'delivered'

    -- Parsed fields (AR side)
    payer_name               TEXT,                    -- "Fresh Plus", "Summer Moon Coffee"
    invoice_number           TEXT,                    -- "45417"
    amount                   NUMERIC(12,2),
    payment_type             TEXT,                    -- 'Check' | 'ACH'
    payment_date             DATE,                    -- when Ramp initiated/processed
    estimated_arrival        DATE,                    -- when funds expected (== payment_date for ACH)
    trace_id                 TEXT,                    -- ACH trace id (helps bank-feed match)

    -- QBO resolution (filled when we post)
    qbo_customer_id          TEXT,
    qbo_customer_name        TEXT,
    qbo_invoice_id           TEXT,
    qbo_invoice_balance      NUMERIC(12,2),           -- balance when matched
    qbo_receive_payment_id   TEXT UNIQUE,             -- set after successful post

    status                   TEXT DEFAULT 'pending',
        -- 'pending'  — staged, awaiting post-ramp-payment to pick it up
        -- 'posted'   — Receive Payment created in QBO (qbo_receive_payment_id stamped)
        -- 'review'   — auto-post declined: invoice missing, already closed, ambiguous,
        --              or amount didn't match Invoice.Balance. Human decides next step.
        -- 'error'    — QBO call failed unexpectedly; safe to retry after fixing root cause
        -- 'ignored'  — out-of-scope at intake (AP event, or `initiated` not yet `delivered`)
    error_message            TEXT,

    email_message_id         TEXT,                    -- Gmail msgid of the event we parsed
    email_subject            TEXT,
    email_received_at        TIMESTAMPTZ,
    raw_email_body           TEXT,
    raw_parse                JSONB,

    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ramp_payments_status ON ramp_payments(status);
CREATE INDEX idx_ramp_payments_invoice ON ramp_payments(invoice_number);

ALTER TABLE ramp_payments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    EXECUTE 'CREATE POLICY "authenticated_select" ON ramp_payments FOR SELECT TO authenticated USING (true)';
    EXECUTE 'CREATE POLICY "authenticated_insert" ON ramp_payments FOR INSERT TO authenticated WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "authenticated_update" ON ramp_payments FOR UPDATE TO authenticated USING (true) WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "authenticated_delete" ON ramp_payments FOR DELETE TO authenticated USING (true)';
END $$;
