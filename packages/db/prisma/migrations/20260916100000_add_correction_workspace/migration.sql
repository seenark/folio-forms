ALTER TABLE "editor_leases"
ADD COLUMN "workspace_base_document_key" TEXT,
ADD COLUMN "workspace_base_revision" INTEGER,
ADD COLUMN "workspace_document_key" TEXT,
ADD COLUMN "workspace_object_key" TEXT;

CREATE UNIQUE INDEX "editor_leases_workspace_document_key_key"
ON "editor_leases"("workspace_document_key");
CREATE OR REPLACE FUNCTION queue_editor_lease_workspace_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  should_queue BOOLEAN := FALSE;
  workspace_object_key TEXT := OLD."workspace_object_key";
BEGIN
  IF workspace_object_key IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    should_queue := TRUE;
  ELSIF TG_OP = 'UPDATE' THEN
    should_queue := NEW."workspace_object_key" IS DISTINCT FROM workspace_object_key;
  END IF;
  IF NOT should_queue
     OR EXISTS (
       SELECT 1
       FROM "operations"
       WHERE "status" IN ('pending', 'processing')
         AND "metadata"->>'workspaceObjectKey' = workspace_object_key
     )
  THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  INSERT INTO "object_cleanup_intents" ("id", "object_key")
  VALUES (gen_random_uuid(), workspace_object_key)
  ON CONFLICT ("object_key") DO NOTHING;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER editor_lease_workspace_cleanup
BEFORE DELETE OR UPDATE OF "workspace_object_key" ON "editor_leases"
FOR EACH ROW
EXECUTE FUNCTION queue_editor_lease_workspace_cleanup();
