-- Re-enable post-ramp-payment cron.
--
-- Audit on 2026-05-15 identified the auto-looking Receive Payments as
-- Amerykah's manual bank-feed matches done in rapid succession ("Added by
-- Book Keeper", "Manually added"). Not an integration. So post-ramp-payment
-- DOES replace real labor and the dup-with-Ramp risk we feared doesn't exist.
--
-- The race between our auto-post and her manual bank-feed match is safe:
-- whoever closes the invoice first wins; the loser sees a closed invoice
-- and backs off (our code marks status='review' with "already closed").
-- No duplicate Payment can be created in QBO under that flow.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'post-ramp-payment') THEN
    PERFORM cron.unschedule('post-ramp-payment');
  END IF;
END $$;

SELECT cron.schedule(
  'post-ramp-payment',
  '9-59/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://efufztdtcfaunizzvcqb.supabase.co/functions/v1/post-ramp-payment',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_ADY2-i0Q5rlwL_d6EcbgeQ_yUssY_cP'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $$
);
