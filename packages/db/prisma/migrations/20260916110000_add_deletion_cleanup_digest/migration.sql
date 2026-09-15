ALTER TABLE "object_cleanup_intents"
ADD COLUMN "deletion_response_lookup_digest" TEXT,
ADD COLUMN "deletion_owner_user_id" TEXT;

CREATE INDEX "object_cleanup_intents_deletion_response_lookup_digest_cleanup_after_idx"
  ON "object_cleanup_intents"("deletion_response_lookup_digest", "cleanup_after");
CREATE INDEX "object_cleanup_intents_deletion_owner_user_id_cleanup_after_idx"
  ON "object_cleanup_intents"("deletion_owner_user_id", "cleanup_after");
