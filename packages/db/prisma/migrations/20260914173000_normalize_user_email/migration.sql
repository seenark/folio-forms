UPDATE "user"
SET "email" = LOWER(BTRIM("email"))
WHERE "email" <> LOWER(BTRIM("email"));

DROP INDEX "user_email_normalized_unique";

CREATE UNIQUE INDEX "user_email_normalized_unique"
ON "user" (LOWER(BTRIM("email")));

ALTER TABLE "user"
  ADD CONSTRAINT "user_email_is_normalized"
  CHECK ("email" = LOWER(BTRIM("email")));
