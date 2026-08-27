CREATE UNIQUE INDEX IF NOT EXISTS "operations_active_form_unique"
  ON "operations" USING btree ("form_id")
  WHERE "response_id" IS NULL AND "status" IN ('pending', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS "operations_active_response_unique"
  ON "operations" USING btree ("response_id")
  WHERE "response_id" IS NOT NULL AND "status" IN ('pending', 'processing');
