-- Store vendor-specific quirks: payment advice format, billing patterns, etc.
ALTER TABLE vendors
  ADD COLUMN payment_notes TEXT;

-- e.g. "Segovia: Authorize.net receipt, Description field contains invoice number
-- range (start-end) covering all bills in that payment period (typically one week)"
