ALTER TABLE "handoffs"
DROP CONSTRAINT "handoffs_form_id_fkey",
ALTER COLUMN "form_id" DROP NOT NULL,
ALTER COLUMN "configuration_hash" DROP NOT NULL;

ALTER TABLE "handoffs"
ADD CONSTRAINT "handoffs_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
