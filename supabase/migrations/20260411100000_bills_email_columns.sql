-- Add email ingress columns to bills table
ALTER TABLE bills
  ADD COLUMN email_message_id TEXT,
  ADD COLUMN email_from       TEXT,
  ADD COLUMN email_subject    TEXT;

-- Prevent re-processing the same email
CREATE UNIQUE INDEX IF NOT EXISTS bills_email_message_id_key
  ON bills (email_message_id)
  WHERE email_message_id IS NOT NULL;
