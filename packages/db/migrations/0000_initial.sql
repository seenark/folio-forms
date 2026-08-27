CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "role" text DEFAULT 'user' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_email_unique" UNIQUE("email"),
  CONSTRAINT "user_role_check" CHECK ("role" IN ('admin', 'user'))
);

CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL,
  CONSTRAINT "session_token_unique" UNIQUE("token"),
  CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "forms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "public_id" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "template_draft_path" text,
  "template_draft_key" text,
  "published_path" text,
  "published_key" text,
  "version" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "forms_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT,
  CONSTRAINT "forms_version_check" CHECK ("version" >= 0),
  CONSTRAINT "forms_status_check" CHECK ("status" IN ('draft', 'published')),
  CONSTRAINT "forms_template_draft_pair_check" CHECK (("template_draft_path" IS NULL) = ("template_draft_key" IS NULL)),
  CONSTRAINT "forms_published_template_pair_check" CHECK (("published_path" IS NULL) = ("published_key" IS NULL)),
  CONSTRAINT "forms_published_status_check" CHECK ("status" <> 'published' OR ("published_path" IS NOT NULL AND "published_key" IS NOT NULL))
);

CREATE TABLE "prefill_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "editable_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prefill_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT
);

CREATE TABLE "prefill_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid,
  "response_id" uuid,
  "form_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "editable_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prefill_snapshots_profile_id_prefill_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "prefill_profiles"("id") ON DELETE SET NULL,
  CONSTRAINT "prefill_snapshots_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT,
  CONSTRAINT "prefill_snapshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT
);

CREATE TABLE "responses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "form_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "prefill_snapshot_id" uuid,
  "draft_data" jsonb,
  "draft_docx_path" text,
  "draft_document_key" text,
  "published_version" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "responses_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT,
  CONSTRAINT "responses_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT,
  CONSTRAINT "responses_prefill_snapshot_id_prefill_snapshots_id_fk" FOREIGN KEY ("prefill_snapshot_id") REFERENCES "prefill_snapshots"("id") ON DELETE SET NULL,
  CONSTRAINT "responses_status_check" CHECK ("status" IN ('draft', 'submitting', 'submitted', 'invalidated')),
  CONSTRAINT "responses_published_version_check" CHECK ("published_version" > 0),
  CONSTRAINT "responses_draft_artifacts_check" CHECK (((("draft_docx_path" IS NULL) = ("draft_document_key" IS NULL)) AND ("draft_data" IS NULL OR ("draft_docx_path" IS NOT NULL AND "draft_document_key" IS NOT NULL))))
);
ALTER TABLE "prefill_snapshots"
  ADD CONSTRAINT "prefill_snapshots_response_id_responses_id_fk"
  FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


CREATE TABLE "submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "response_id" uuid NOT NULL,
  "form_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "data" jsonb NOT NULL,
  "data_path" text NOT NULL,
  "docx_path" text NOT NULL,
  "pdf_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "submissions_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE RESTRICT,
  CONSTRAINT "submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT,
  CONSTRAINT "submissions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT
);

CREATE TABLE "operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "form_id" uuid NOT NULL,
  "response_id" uuid,
  "submission_id" uuid,
  "document_key" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operations_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT,
  CONSTRAINT "operations_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE SET NULL,
  CONSTRAINT "operations_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE SET NULL,
  CONSTRAINT "operations_type_check" CHECK ("type" IN ('save_template_draft', 'publish_form', 'save_draft', 'submit_response')),
  CONSTRAINT "operations_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");
CREATE UNIQUE INDEX "account_provider_account_unique" ON "account" USING btree ("provider_id", "account_id");
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
CREATE INDEX "verification_expires_at_idx" ON "verification" USING btree ("expires_at");
CREATE UNIQUE INDEX "forms_public_id_unique" ON "forms" USING btree ("public_id");
CREATE INDEX "forms_created_by_idx" ON "forms" USING btree ("created_by");
CREATE INDEX "forms_status_idx" ON "forms" USING btree ("status");
CREATE INDEX "prefill_profiles_user_id_idx" ON "prefill_profiles" USING btree ("user_id");
CREATE UNIQUE INDEX "prefill_profiles_user_name_unique" ON "prefill_profiles" USING btree ("user_id", "name");
CREATE INDEX "prefill_snapshots_profile_id_idx" ON "prefill_snapshots" USING btree ("profile_id");
CREATE INDEX "prefill_snapshots_response_id_idx" ON "prefill_snapshots" USING btree ("response_id");
CREATE INDEX "prefill_snapshots_form_user_idx" ON "prefill_snapshots" USING btree ("form_id", "user_id");
CREATE UNIQUE INDEX "responses_form_user_unique" ON "responses" USING btree ("form_id", "user_id");
CREATE INDEX "responses_form_id_idx" ON "responses" USING btree ("form_id");
CREATE INDEX "responses_user_id_idx" ON "responses" USING btree ("user_id");
CREATE INDEX "responses_status_idx" ON "responses" USING btree ("status");
CREATE INDEX "responses_prefill_snapshot_id_idx" ON "responses" USING btree ("prefill_snapshot_id");
CREATE UNIQUE INDEX "submissions_response_unique" ON "submissions" USING btree ("response_id");
CREATE INDEX "submissions_form_id_idx" ON "submissions" USING btree ("form_id");
CREATE INDEX "submissions_user_id_idx" ON "submissions" USING btree ("user_id");
CREATE INDEX "operations_type_status_idx" ON "operations" USING btree ("type", "status");
CREATE INDEX "operations_form_id_idx" ON "operations" USING btree ("form_id");
CREATE INDEX "operations_response_id_idx" ON "operations" USING btree ("response_id");
CREATE INDEX "operations_submission_id_idx" ON "operations" USING btree ("submission_id");
CREATE INDEX "operations_document_key_idx" ON "operations" USING btree ("document_key");
