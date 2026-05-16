-- Schedule post-ramp-payment after scan-ramp so newly-staged deliveries get
-- posted to QBO within minutes of arrival.
--
--   :07, :22, :37, :52  →  scan-ramp           (stage from Gmail)
--   :09, :24, :39, :54  →  post-ramp-payment   (post pending+delivered+ar)

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
