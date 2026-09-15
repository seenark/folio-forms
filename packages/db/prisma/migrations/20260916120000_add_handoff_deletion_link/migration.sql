ALTER TABLE "handoffs"
ADD COLUMN "deletion_response_lookup_digest" TEXT;

CREATE INDEX "handoffs_deletion_response_lookup_digest_updated_at_idx"
  ON "handoffs"("deletion_response_lookup_digest", "updated_at");
