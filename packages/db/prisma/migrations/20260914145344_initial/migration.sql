-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('text', 'checkbox', 'date', 'dropdown', 'combo', 'picture');

-- CreateEnum
CREATE TYPE "PrefillPolicy" AS ENUM ('editable', 'lock_when_available');

-- CreateEnum
CREATE TYPE "ResponseStatus" AS ENUM ('draft', 'submitting', 'submitted');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('save_template_draft', 'publish_form', 'save_draft', 'submit_response', 'save_correction');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "OperationTargetType" AS ENUM ('template_draft', 'response', 'correction');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('pending', 'reserved', 'consumed', 'expired', 'deleted');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('success', 'failure');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "issuer" TEXT NOT NULL DEFAULT 'local:credential',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "public_id" TEXT NOT NULL,
    "status" "FormStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_drafts" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "content_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_field_rules" (
    "id" UUID NOT NULL,
    "template_draft_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "prefill_pointer" TEXT,
    "prefill_policy" "PrefillPolicy" NOT NULL DEFAULT 'editable',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_field_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_templates" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_manifests" (
    "id" UUID NOT NULL,
    "published_template_id" UUID NOT NULL,
    "configuration_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifest_fields" (
    "id" UUID NOT NULL,
    "manifest_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "prefill_policy" "PrefillPolicy" NOT NULL DEFAULT 'editable',
    "options" JSONB,
    "picture_max_bytes" INTEGER,
    "picture_max_width" INTEGER,
    "picture_max_height" INTEGER,

    CONSTRAINT "manifest_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prefill_configurations" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "published_template_id" UUID,
    "configuration_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prefill_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prefill_fields" (
    "id" UUID NOT NULL,
    "configuration_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "pointer" TEXT NOT NULL,
    "policy" "PrefillPolicy" NOT NULL DEFAULT 'editable',

    CONSTRAINT "prefill_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responses" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "published_template_id" UUID NOT NULL,
    "published_version" INTEGER NOT NULL,
    "status" "ResponseStatus" NOT NULL DEFAULT 'draft',
    "draft_data" JSONB,
    "draft_object_key" TEXT,
    "draft_document_key" TEXT,
    "external_reference_digest" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prefill_snapshots" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "locked_fields" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prefill_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "object_key" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corrections" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "actor_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_data" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "object_key" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handoffs" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "response_id" UUID,
    "normalized_email" TEXT,
    "external_reference_digest" TEXT NOT NULL,
    "code_digest" TEXT,
    "filtered_values" JSONB,
    "configuration_hash" TEXT NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "reserved_at" TIMESTAMPTZ(3),
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_claims" (
    "id" UUID NOT NULL,
    "handoff_id" UUID NOT NULL,
    "claim_digest" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations" (
    "id" UUID NOT NULL,
    "type" "OperationType" NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'pending',
    "target_type" "OperationTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "response_id" UUID,
    "submission_id" UUID,
    "correction_id" UUID,
    "actor_id" TEXT,
    "owner_user_id" TEXT,
    "document_key" TEXT,
    "staging_object_key" TEXT,
    "metadata" JSONB NOT NULL,
    "result" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "callback_claims" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "token_digest" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "callback_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editor_leases" (
    "id" UUID NOT NULL,
    "target_type" "OperationTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "holder_session_id" TEXT NOT NULL,
    "holder_user_id" TEXT NOT NULL,
    "capability_digest" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editor_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "safe_metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_failures" (
    "id" UUID NOT NULL,
    "email_digest" TEXT NOT NULL,
    "ip_digest" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_tombstones" (
    "id" UUID NOT NULL,
    "response_lookup_digest" TEXT NOT NULL,
    "external_reference_digest" TEXT,
    "actor_id" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_role_enabled_idx" ON "user"("role", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "account"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "account"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "account_issuer_idx" ON "account"("issuer");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expires_at_idx" ON "verification"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "forms_public_id_key" ON "forms"("public_id");

-- CreateIndex
CREATE INDEX "forms_created_by_idx" ON "forms"("created_by");

-- CreateIndex
CREATE INDEX "forms_status_updated_at_idx" ON "forms"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "template_drafts_form_id_key" ON "template_drafts"("form_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_drafts_document_key_key" ON "template_drafts"("document_key");


-- CreateIndex
CREATE UNIQUE INDEX "draft_field_rules_template_draft_id_tag_key" ON "draft_field_rules"("template_draft_id", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "draft_field_rules_template_draft_id_prefill_pointer_key" ON "draft_field_rules"("template_draft_id", "prefill_pointer");

-- CreateIndex
CREATE UNIQUE INDEX "published_templates_form_id_key" ON "published_templates"("form_id");

-- CreateIndex
CREATE UNIQUE INDEX "published_templates_document_key_key" ON "published_templates"("document_key");

-- CreateIndex
CREATE UNIQUE INDEX "published_templates_form_id_version_key" ON "published_templates"("form_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "field_manifests_published_template_id_key" ON "field_manifests"("published_template_id");

-- CreateIndex
CREATE INDEX "manifest_fields_manifest_id_idx" ON "manifest_fields"("manifest_id");

-- CreateIndex
CREATE UNIQUE INDEX "manifest_fields_manifest_id_tag_key" ON "manifest_fields"("manifest_id", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "prefill_configurations_form_id_key" ON "prefill_configurations"("form_id");

-- CreateIndex
CREATE UNIQUE INDEX "prefill_configurations_published_template_id_key" ON "prefill_configurations"("published_template_id");

-- CreateIndex
CREATE INDEX "prefill_fields_configuration_id_idx" ON "prefill_fields"("configuration_id");

-- CreateIndex
CREATE UNIQUE INDEX "prefill_fields_configuration_id_tag_key" ON "prefill_fields"("configuration_id", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "prefill_fields_configuration_id_pointer_key" ON "prefill_fields"("configuration_id", "pointer");

-- CreateIndex
CREATE UNIQUE INDEX "responses_draft_document_key_key" ON "responses"("draft_document_key");

-- CreateIndex
CREATE UNIQUE INDEX "responses_external_reference_digest_key" ON "responses"("external_reference_digest");

-- CreateIndex
CREATE INDEX "responses_form_id_status_updated_at_idx" ON "responses"("form_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "responses_user_id_updated_at_idx" ON "responses"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "responses_form_id_user_id_key" ON "responses"("form_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "prefill_snapshots_response_id_key" ON "prefill_snapshots"("response_id");

-- CreateIndex
CREATE INDEX "prefill_snapshots_form_id_user_id_idx" ON "prefill_snapshots"("form_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_response_id_key" ON "submissions"("response_id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_document_key_key" ON "submissions"("document_key");

-- CreateIndex
CREATE INDEX "submissions_form_id_created_at_idx" ON "submissions"("form_id", "created_at");

-- CreateIndex
CREATE INDEX "submissions_user_id_created_at_idx" ON "submissions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "corrections_submission_id_revision_idx" ON "corrections"("submission_id", "revision");

-- CreateIndex
CREATE INDEX "corrections_actor_id_created_at_idx" ON "corrections"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "corrections_response_id_revision_key" ON "corrections"("response_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "corrections_document_key_key" ON "corrections"("document_key");

-- CreateIndex
CREATE INDEX "handoffs_response_id_idx" ON "handoffs"("response_id");

-- CreateIndex
CREATE INDEX "handoffs_external_reference_digest_created_at_idx" ON "handoffs"("external_reference_digest", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "handoffs_code_digest_key" ON "handoffs"("code_digest");

-- CreateIndex
CREATE INDEX "handoffs_form_id_status_expires_at_idx" ON "handoffs"("form_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "handoffs_status_expires_at_idx" ON "handoffs"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "pending_claims_handoff_id_key" ON "pending_claims"("handoff_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_claims_claim_digest_key" ON "pending_claims"("claim_digest");

-- CreateIndex
CREATE INDEX "pending_claims_expires_at_idx" ON "pending_claims"("expires_at");

-- CreateIndex
CREATE INDEX "operations_target_type_target_id_status_idx" ON "operations"("target_type", "target_id", "status");

-- CreateIndex
CREATE INDEX "operations_form_id_created_at_idx" ON "operations"("form_id", "created_at");

-- CreateIndex
CREATE INDEX "operations_response_id_created_at_idx" ON "operations"("response_id", "created_at");

-- CreateIndex
CREATE INDEX "operations_submission_id_idx" ON "operations"("submission_id");

-- CreateIndex
CREATE INDEX "operations_correction_id_idx" ON "operations"("correction_id");

-- CreateIndex
CREATE INDEX "operations_document_key_idx" ON "operations"("document_key");

-- CreateIndex
CREATE UNIQUE INDEX "callback_claims_operation_id_key" ON "callback_claims"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "callback_claims_token_digest_key" ON "callback_claims"("token_digest");

-- CreateIndex
CREATE INDEX "callback_claims_expires_at_idx" ON "callback_claims"("expires_at");

-- CreateIndex
CREATE INDEX "editor_leases_expires_at_idx" ON "editor_leases"("expires_at");

-- CreateIndex
CREATE INDEX "editor_leases_holder_session_id_idx" ON "editor_leases"("holder_session_id");

-- CreateIndex
CREATE INDEX "editor_leases_holder_user_id_idx" ON "editor_leases"("holder_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "editor_leases_target_type_target_id_key" ON "editor_leases"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_events_created_at_id_idx" ON "audit_events"("created_at", "id");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_created_at_idx" ON "audit_events"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_target_type_target_id_created_at_idx" ON "audit_events"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_outcome_created_at_idx" ON "audit_events"("outcome", "created_at");

-- CreateIndex
CREATE INDEX "login_failures_expires_at_idx" ON "login_failures"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "login_failures_email_digest_ip_digest_key" ON "login_failures"("email_digest", "ip_digest");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_tombstones_response_lookup_digest_key" ON "deletion_tombstones"("response_lookup_digest");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_tombstones_external_reference_digest_key" ON "deletion_tombstones"("external_reference_digest");

-- CreateIndex
CREATE INDEX "deletion_tombstones_actor_id_created_at_idx" ON "deletion_tombstones"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_drafts" ADD CONSTRAINT "template_drafts_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_field_rules" ADD CONSTRAINT "draft_field_rules_template_draft_id_fkey" FOREIGN KEY ("template_draft_id") REFERENCES "template_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_templates" ADD CONSTRAINT "published_templates_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_manifests" ADD CONSTRAINT "field_manifests_published_template_id_fkey" FOREIGN KEY ("published_template_id") REFERENCES "published_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest_fields" ADD CONSTRAINT "manifest_fields_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "field_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefill_configurations" ADD CONSTRAINT "prefill_configurations_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefill_configurations" ADD CONSTRAINT "prefill_configurations_published_template_id_fkey" FOREIGN KEY ("published_template_id") REFERENCES "published_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefill_fields" ADD CONSTRAINT "prefill_fields_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "prefill_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responses" ADD CONSTRAINT "responses_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responses" ADD CONSTRAINT "responses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responses" ADD CONSTRAINT "responses_published_template_id_fkey" FOREIGN KEY ("published_template_id") REFERENCES "published_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefill_snapshots" ADD CONSTRAINT "prefill_snapshots_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefill_snapshots" ADD CONSTRAINT "prefill_snapshots_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prefill_snapshots" ADD CONSTRAINT "prefill_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_claims" ADD CONSTRAINT "pending_claims_handoff_id_fkey" FOREIGN KEY ("handoff_id") REFERENCES "handoffs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_correction_id_fkey" FOREIGN KEY ("correction_id") REFERENCES "corrections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "callback_claims" ADD CONSTRAINT "callback_claims_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editor_leases" ADD CONSTRAINT "editor_leases_holder_session_id_fkey" FOREIGN KEY ("holder_session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editor_leases" ADD CONSTRAINT "editor_leases_holder_user_id_fkey" FOREIGN KEY ("holder_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Accepted domain invariants not expressible in Prisma schema.
CREATE UNIQUE INDEX "user_email_normalized_unique" ON "user" (LOWER("email"));

ALTER TABLE "forms"
  ADD CONSTRAINT "forms_version_nonnegative" CHECK ("version" >= 0);

ALTER TABLE "draft_field_rules"
  ADD CONSTRAINT "draft_field_rules_tag_present" CHECK (length(trim("tag")) > 0),
  ADD CONSTRAINT "draft_field_rules_prefill_pointer_present" CHECK (
    "prefill_pointer" IS NULL OR length(trim("prefill_pointer")) > 0
  ),
  ADD CONSTRAINT "draft_field_rules_policy_requires_pointer" CHECK (
    "prefill_pointer" IS NOT NULL OR "prefill_policy" = 'editable'
  );

ALTER TABLE "published_templates"
  ADD CONSTRAINT "published_templates_version_positive" CHECK ("version" > 0);

ALTER TABLE "manifest_fields"
  ADD CONSTRAINT "manifest_fields_options_shape" CHECK (
    (
      "type" IN ('dropdown', 'combo')
      AND "options" IS NOT NULL
      AND jsonb_typeof("options") = 'array'
    )
    OR (
      "type" NOT IN ('dropdown', 'combo')
      AND "options" IS NULL
    )
  ),
  ADD CONSTRAINT "manifest_fields_picture_limits" CHECK (
    (
      "type" = 'picture'
      AND "picture_max_bytes" = 10485760
      AND "picture_max_width" = 4096
      AND "picture_max_height" = 4096
    )
    OR (
      "type" <> 'picture'
      AND "picture_max_bytes" IS NULL
      AND "picture_max_width" IS NULL
      AND "picture_max_height" IS NULL
    )
  );

ALTER TABLE "responses"
  ADD CONSTRAINT "responses_published_version_positive" CHECK ("published_version" > 0),
  ADD CONSTRAINT "responses_draft_document_pair" CHECK (
    ("draft_object_key" IS NULL) = ("draft_document_key" IS NULL)
  ),
  ADD CONSTRAINT "responses_draft_data_has_document" CHECK (
    "draft_data" IS NULL
    OR ("draft_object_key" IS NOT NULL AND "draft_document_key" IS NOT NULL)
  ),
  ADD CONSTRAINT "responses_editable_has_document" CHECK (
    "status" = 'submitted'
    OR ("draft_object_key" IS NOT NULL AND "draft_document_key" IS NOT NULL)
  ),
  ADD CONSTRAINT "responses_submitted_has_no_draft" CHECK (
    "status" <> 'submitted'
    OR (
      "draft_data" IS NULL
      AND "draft_object_key" IS NULL
      AND "draft_document_key" IS NULL
    )
  );

ALTER TABLE "corrections"
  ADD CONSTRAINT "corrections_revision_positive" CHECK ("revision" > 0),
  ADD CONSTRAINT "corrections_reason_present" CHECK (length(trim("reason")) > 0);

ALTER TABLE "handoffs"
  ADD CONSTRAINT "handoffs_expiry_after_creation" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "handoffs_configuration_hash_present" CHECK (length("configuration_hash") > 0);

ALTER TABLE "pending_claims"
  ADD CONSTRAINT "pending_claims_expiry_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "operations"
  ADD CONSTRAINT "operations_target_matches_relations" CHECK (
    (
      "target_type" = 'template_draft'
      AND "response_id" IS NULL
      AND "submission_id" IS NULL
      AND "correction_id" IS NULL
    )
    OR (
      "target_type" = 'response'
      AND "response_id" IS NOT NULL
      AND "target_id" = "response_id"
      AND "correction_id" IS NULL
    )
    OR (
      "target_type" = 'correction'
      AND "response_id" IS NOT NULL
      AND "submission_id" IS NOT NULL
      AND (
        "correction_id" IS NULL
        OR "target_id" = "correction_id"
      )
    )
  ),
  ADD CONSTRAINT "operations_type_matches_target" CHECK (
    ("type" IN ('save_template_draft', 'publish_form') AND "target_type" = 'template_draft')
    OR ("type" IN ('save_draft', 'submit_response') AND "target_type" = 'response')
    OR ("type" = 'save_correction' AND "target_type" = 'correction')
  );

CREATE UNIQUE INDEX "operations_one_active_target"
  ON "operations" ("target_type", "target_id")
  WHERE "status" IN ('pending', 'processing');

ALTER TABLE "callback_claims"
  ADD CONSTRAINT "callback_claims_expiry_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "editor_leases"
  ADD CONSTRAINT "editor_leases_expiry_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "login_failures"
  ADD CONSTRAINT "login_failures_attempts_nonnegative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "login_failures_expiry_after_window" CHECK ("expires_at" > "window_started_at");

-- Published contracts and completed records are append-only. Personal Submission
-- and Correction rows remain deletable only for the explicit erasure workflow.
CREATE FUNCTION reject_immutable_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "published_templates_immutable"
  BEFORE UPDATE OR DELETE ON "published_templates"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER "field_manifests_immutable"
  BEFORE UPDATE OR DELETE ON "field_manifests"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER "manifest_fields_immutable"
  BEFORE UPDATE OR DELETE ON "manifest_fields"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER "submissions_immutable"
  BEFORE UPDATE ON "submissions"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER "corrections_immutable"
  BEFORE UPDATE ON "corrections"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER "audit_events_immutable"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER "deletion_tombstones_immutable"
  BEFORE UPDATE OR DELETE ON "deletion_tombstones"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE FUNCTION reject_published_configuration_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."published_template_id" IS NOT NULL THEN
    RAISE EXCEPTION 'published prefill configuration is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "published_prefill_configuration_immutable"
  BEFORE UPDATE OR DELETE ON "prefill_configurations"
  FOR EACH ROW EXECUTE FUNCTION reject_published_configuration_change();

CREATE FUNCTION reject_published_prefill_field_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  configuration_id UUID := COALESCE(NEW."configuration_id", OLD."configuration_id");
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "prefill_configurations"
    WHERE "id" = configuration_id
      AND "published_template_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'published prefill fields are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "published_prefill_fields_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "prefill_fields"
  FOR EACH ROW EXECUTE FUNCTION reject_published_prefill_field_change();
