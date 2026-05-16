-- Disable the post-ramp-payment cron.
--
-- Investigation on 2026-05-15 showed an automated process (likely Ramp's
-- own QBO integration) is already posting AR Receive Payments to QBO when
-- Ramp's ACH clears — same shape we were building (close the invoice, no
-- manual bank-feed match needed). Running our cron alongside risks creating
-- duplicate Receive Payments on the same Ramp event.
--
-- scan-ramp keeps running — the staged `ramp_payments` data is still useful
-- for visibility and for the phase-3 check-rail post-on-initiated work where
-- the existing integration doesn't help (Ramp doesn't fire a `delivered`
-- event for mailed checks).
--
-- Reversible: re-running migration 20260515230000_pg_cron_post_ramp_payment.sql
-- re-establishes the schedule.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'post-ramp-payment') THEN
    PERFORM cron.unschedule('post-ramp-payment');
  END IF;
END $$;
