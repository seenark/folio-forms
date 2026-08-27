import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Better Auth's user table. Keep the column names and types in sync with the
 * Drizzle adapter's default schema; `role` is application-owned metadata.
 */
export const user = pgTable(
  "user",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    id: text("id").primaryKey(),
    image: text("image"),
    name: text("name").notNull(),
    role: text("role").notNull().default("user"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    roleCheck: check(
      "user_role_check",
      sql`${table.role} in ('admin', 'user')`
    ),
  })
);

/** Better Auth's session table. */
export const session = pgTable(
  "session",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => ({
    expiresAtIndex: index("session_expires_at_idx").on(table.expiresAt),
    userIdIndex: index("session_user_id_idx").on(table.userId),
  })
);

/** Better Auth's account table. */
export const account = pgTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    accountId: text("account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    issuer: text("issuer").notNull().default("local:credential"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => ({
    providerAccountUnique: uniqueIndex("account_provider_account_unique").on(
      table.providerId,
      table.accountId
    ),
    userIdIndex: index("account_user_id_idx").on(table.userId),
  })
);

/** Better Auth's verification table. */
export const verification = pgTable(
  "verification",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    value: text("value").notNull(),
  },
  (table) => ({
    expiresAtIndex: index("verification_expires_at_idx").on(table.expiresAt),
    identifierIndex: index("verification_identifier_idx").on(table.identifier),
  })
);

export const formStatuses = ["draft", "published"] as const;
export type FormStatus = (typeof formStatuses)[number];

export const responseStatuses = [
  "draft",
  "submitting",
  "submitted",
  "invalidated",
] as const;
export type ResponseStatus = (typeof responseStatuses)[number];

export const operationTypes = [
  "save_template_draft",
  "publish_form",
  "save_draft",
  "submit_response",
] as const;
export type OperationType = (typeof operationTypes)[number];

export const operationStatuses = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export type FieldData = Record<string, unknown>;
export type EditableFields = Record<string, unknown>;

/** A shareable form and its current template artifacts. */
export const forms = pgTable(
  "forms",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    description: text("description"),
    id: uuid("id").defaultRandom().primaryKey(),
    publicId: text("public_id").notNull(),
    publishedKey: text("published_key"),
    publishedPath: text("published_path"),
    status: text("status").$type<FormStatus>().notNull().default("draft"),
    templateDraftKey: text("template_draft_key"),
    templateDraftPath: text("template_draft_path"),
    title: text("title").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => ({
    createdByIndex: index("forms_created_by_idx").on(table.createdBy),
    publicIdUnique: uniqueIndex("forms_public_id_unique").on(table.publicId),
    publishedStatusCheck: check(
      "forms_published_status_check",
      sql`(${table.status} <> 'published') or (${table.publishedPath} is not null and ${table.publishedKey} is not null)`
    ),
    publishedTemplatePairCheck: check(
      "forms_published_template_pair_check",
      sql`(${table.publishedPath} is null) = (${table.publishedKey} is null)`
    ),
    statusCheck: check(
      "forms_status_check",
      sql`${table.status} in ('draft', 'published')`
    ),
    statusIndex: index("forms_status_idx").on(table.status),
    templateDraftPairCheck: check(
      "forms_template_draft_pair_check",
      sql`(${table.templateDraftPath} is null) = (${table.templateDraftKey} is null)`
    ),
    versionCheck: check("forms_version_check", sql`${table.version} >= 0`),
  })
);

/** Reusable application-provided values and editability policy for a user. */
export const prefillProfiles = pgTable(
  "prefill_profiles",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    data: jsonb("data").$type<FieldData>().notNull().default({}),
    editableFields: jsonb("editable_fields")
      .$type<EditableFields>()
      .notNull()
      .default({}),
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => ({
    userIdIndex: index("prefill_profiles_user_id_idx").on(table.userId),
    userNameUnique: uniqueIndex("prefill_profiles_user_name_unique").on(
      table.userId,
      table.name
    ),
  })
);

/** Immutable values/policies copied when a response starts. */
export const prefillSnapshots = pgTable(
  "prefill_snapshots",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    data: jsonb("data").$type<FieldData>().notNull().default({}),
    editableFields: jsonb("editable_fields")
      .$type<EditableFields>()
      .notNull()
      .default({}),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "restrict" }),
    id: uuid("id").defaultRandom().primaryKey(),
    profileId: uuid("profile_id").references(() => prefillProfiles.id, {
      onDelete: "set null",
    }),
    // The SQL migration adds this foreign key after both tables exist.
    // Keeping the declaration plain avoids a circular table initializer.
    responseId: uuid("response_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => ({
    formUserIndex: index("prefill_snapshots_form_user_idx").on(
      table.formId,
      table.userId
    ),
    profileIdIndex: index("prefill_snapshots_profile_id_idx").on(
      table.profileId
    ),
    responseIdIndex: index("prefill_snapshots_response_id_idx").on(
      table.responseId
    ),
  })
);

/** A user's single attempt at filling a form. */
export const responses = pgTable(
  "responses",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    draftData: jsonb("draft_data").$type<FieldData>(),
    draftDocumentKey: text("draft_document_key"),
    draftDocxPath: text("draft_docx_path"),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "restrict" }),
    id: uuid("id").defaultRandom().primaryKey(),
    prefillSnapshotId: uuid("prefill_snapshot_id").references(
      () => prefillSnapshots.id,
      { onDelete: "set null" }
    ),
    publishedVersion: integer("published_version").notNull(),
    status: text("status").$type<ResponseStatus>().notNull().default("draft"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => ({
    draftArtifactsCheck: check(
      "responses_draft_artifacts_check",
      sql`(
        (${table.draftDocxPath} is null) = (${table.draftDocumentKey} is null)
      ) and (
        ${table.draftData} is null or (
          ${table.draftDocxPath} is not null and
          ${table.draftDocumentKey} is not null
        )
      )`
    ),
    formIdIndex: index("responses_form_id_idx").on(table.formId),
    formUserUnique: uniqueIndex("responses_form_user_unique").on(
      table.formId,
      table.userId
    ),
    prefillSnapshotIndex: index("responses_prefill_snapshot_id_idx").on(
      table.prefillSnapshotId
    ),
    publishedVersionCheck: check(
      "responses_published_version_check",
      sql`${table.publishedVersion} > 0`
    ),
    statusCheck: check(
      "responses_status_check",
      sql`${table.status} in ('draft', 'submitting', 'submitted', 'invalidated')`
    ),
    statusIndex: index("responses_status_idx").on(table.status),
    userIdIndex: index("responses_user_id_idx").on(table.userId),
  })
);

/** Immutable extracted data and persisted document artifacts for a response. */
export const submissions = pgTable(
  "submissions",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    data: jsonb("data").$type<FieldData>().notNull(),
    dataPath: text("data_path").notNull(),
    docxPath: text("docx_path").notNull(),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "restrict" }),
    id: uuid("id").defaultRandom().primaryKey(),
    pdfPath: text("pdf_path").notNull(),
    responseId: uuid("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => ({
    formIdIndex: index("submissions_form_id_idx").on(table.formId),
    responseUnique: uniqueIndex("submissions_response_unique").on(
      table.responseId
    ),
    userIdIndex: index("submissions_user_id_idx").on(table.userId),
  })
);

/** A tracked asynchronous form/document operation. */
export const operations = pgTable(
  "operations",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    documentKey: text("document_key"),
    error: text("error"),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "restrict" }),
    id: uuid("id").defaultRandom().primaryKey(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    responseId: uuid("response_id").references(() => responses.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<OperationStatus>()
      .notNull()
      .default("pending"),
    submissionId: uuid("submission_id").references(() => submissions.id, {
      onDelete: "set null",
    }),
    type: text("type").$type<OperationType>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    activeFormOperationUnique: uniqueIndex("operations_active_form_unique")
      .on(table.formId)
      .where(
        sql`${table.responseId} is null and ${table.status} in ('pending', 'processing')`
      ),
    activeResponseOperationUnique: uniqueIndex(
      "operations_active_response_unique"
    )
      .on(table.responseId)
      .where(
        sql`${table.responseId} is not null and ${table.status} in ('pending', 'processing')`
      ),
    documentKeyIndex: index("operations_document_key_idx").on(
      table.documentKey
    ),
    formIdIndex: index("operations_form_id_idx").on(table.formId),
    responseIdIndex: index("operations_response_id_idx").on(table.responseId),
    statusCheck: check(
      "operations_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'failed')`
    ),
    submissionIdIndex: index("operations_submission_id_idx").on(
      table.submissionId
    ),
    typeCheck: check(
      "operations_type_check",
      sql`${table.type} in ('save_template_draft', 'publish_form', 'save_draft', 'submit_response')`
    ),
    typeStatusIndex: index("operations_type_status_idx").on(
      table.type,
      table.status
    ),
  })
);

export const authSchema = { account, session, user, verification } as const;

export const tables = {
  ...authSchema,
  forms,
  operations,
  prefillProfiles,
  prefillSnapshots,
  responses,
  submissions,
} as const;

/** Complete schema object for Drizzle relational queries and Better Auth. */
export const schema = tables;

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;
export type Verification = typeof verification.$inferSelect;
export type NewVerification = typeof verification.$inferInsert;
export type Form = typeof forms.$inferSelect;
export type NewForm = typeof forms.$inferInsert;
export type Response = typeof responses.$inferSelect;
export type NewResponse = typeof responses.$inferInsert;
export type PrefillProfile = typeof prefillProfiles.$inferSelect;
export type NewPrefillProfile = typeof prefillProfiles.$inferInsert;
export type PrefillSnapshot = typeof prefillSnapshots.$inferSelect;
export type NewPrefillSnapshot = typeof prefillSnapshots.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
export type Operation = typeof operations.$inferSelect;
export type NewOperation = typeof operations.$inferInsert;
export type DatabaseTables = typeof tables;
