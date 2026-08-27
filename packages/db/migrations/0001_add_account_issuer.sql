ALTER TABLE "account"
  ADD COLUMN IF NOT EXISTS "issuer" text DEFAULT 'local:credential' NOT NULL;

CREATE INDEX IF NOT EXISTS "account_issuer_idx" ON "account" USING btree ("issuer");
