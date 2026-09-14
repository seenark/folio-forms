CREATE TABLE "object_cleanup_intents" (
    "id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "cleanup_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "object_cleanup_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "object_cleanup_intents_object_key_key"
ON "object_cleanup_intents"("object_key");

CREATE INDEX "object_cleanup_intents_cleanup_after_created_at_idx"
ON "object_cleanup_intents"("cleanup_after", "created_at");
