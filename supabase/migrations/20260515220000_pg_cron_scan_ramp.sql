-- Schedule scan-ramp to stage AR Ramp payment notifications into ramp_payments.
--
--   :07, :22, :37, :52  →  scan-ramp  (slots after scan-email's :05/:20/:35/:50)
--
-- Idempotent — re-running this migration drops and re-creates the job.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scan-ramp') THEN
    PERFORM cron.unschedule('scan-ramp');
  END IF;
END $$;

SELECT cron.schedule(
  'scan-ramp',
  '7-59/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://efufztdtcfaunizzvcqb.supabase.co/functions/v1/scan-ramp',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_ADY2-i0Q5rlwL_d6EcbgeQ_yUssY_cP'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
