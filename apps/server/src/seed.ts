// oxlint-disable func-style prefer-destructuring prefer-ternary no-await-in-loop -- Seed order and updates are intentionally sequential.
import path from "node:path";

import { auth } from "@onlyoffice/auth";
import { closeDb, db, forms, prefillProfiles, user } from "@onlyoffice/db";
import { env } from "@onlyoffice/env/server";
import { and, eq } from "drizzle-orm";

import { artifactExists, artifactPath, writeArtifact } from "./storage";

interface DemoAccount {
  email: string;
  name: string;
  password: string;
  role: "admin" | "user";
  profile: {
    data: Record<string, unknown>;
    editableFields: Record<string, boolean>;
  };
}

const demoAccounts: DemoAccount[] = [
  {
    email: "admin@example.com",
    name: "Demo Admin",
    password: "AdminPassword123!",
    profile: {
      data: {
        department: "finance",
        full_name: "Demo Admin",
        start_date: "2024-01-15",
      },
      editableFields: { department: false, full_name: false, start_date: true },
    },
    role: "admin",
  },
  {
    email: "user-a@example.com",
    name: "User A",
    password: "UserAPassword123!",
    profile: {
      data: {
        department: "hr",
        full_name: "User A",
        start_date: "2024-02-01",
      },
      editableFields: { department: false, full_name: false, start_date: true },
    },
    role: "user",
  },
  {
    email: "user-b@example.com",
    name: "User B",
    password: "UserBPassword123!",
    profile: {
      data: {
        department: "engineering",
        full_name: "User B",
        start_date: "2024-03-01",
      },
      editableFields: { department: false, full_name: false, start_date: true },
    },
    role: "user",
  },
];

async function ensureAccount(account: DemoAccount): Promise<string> {
  const existingRows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, account.email))
    .limit(1);
  const existing = existingRows[0];
  let userId = existing?.id;
  if (!userId) {
    const result = await auth.api.signUpEmail({
      body: {
        email: account.email,
        name: account.name,
        password: account.password,
      },
    });
    const createdUser = result?.user as unknown as { id?: unknown } | undefined;
    if (!createdUser || typeof createdUser.id !== "string") {
      throw new Error(`Better Auth did not create ${account.email}`);
    }
    userId = createdUser.id;
  }

  await db
    .update(user)
    .set({ name: account.name, role: account.role, updatedAt: new Date() })
    .where(eq(user.id, userId));
  const profileRows = await db
    .select({ id: prefillProfiles.id })
    .from(prefillProfiles)
    .where(
      and(eq(prefillProfiles.userId, userId), eq(prefillProfiles.name, "demo"))
    )
    .limit(1);
  const profile = profileRows[0];
  if (profile) {
    await db
      .update(prefillProfiles)
      .set({
        data: account.profile.data,
        editableFields: account.profile.editableFields,
        updatedAt: new Date(),
      })
      .where(eq(prefillProfiles.id, profile.id));
  } else {
    await db.insert(prefillProfiles).values({
      data: account.profile.data,
      editableFields: account.profile.editableFields,
      name: "demo",
      userId,
    });
  }
  return userId;
}
async function ensureDemoForm(adminId: string): Promise<void> {
  const existingRows = await db
    .select()
    .from(forms)
    .where(eq(forms.publicId, "demo-employee-intake"))
    .limit(1);
  const existing = existingRows[0];
  const projectRoot = path.resolve(import.meta.dirname, "../../..");
  const sourceCandidates = [
    env.TEMPLATE_PATH,
    path.resolve(projectRoot, "onlyoffice-templates/template.docx"),
    path.resolve(process.cwd(), "onlyoffice-templates/template.docx"),
  ];
  let sourcePath: string | undefined;
  for (const candidate of sourceCandidates) {
    if (await Bun.file(candidate).exists()) {
      sourcePath = candidate;
      break;
    }
  }
  if (existing) {
    if (!sourcePath) {
      return;
    }
    const document = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
    for (const artifact of [
      existing.templateDraftPath,
      existing.publishedPath,
    ]) {
      if (artifact && !(await artifactExists(artifact))) {
        await writeArtifact(artifact, document);
      }
    }
    return;
  }
  if (!sourcePath) {
    return;
  }

  const formId = crypto.randomUUID();
  const templateDraftPath = artifactPath(
    "forms",
    formId,
    "template-draft.docx"
  );
  const publishedPath = artifactPath("forms", formId, "published-1.docx");
  const templateDraftKey = `form-${formId}-draft-${crypto.randomUUID()}`;
  const publishedKey = `form-${formId}-published-1-${crypto.randomUUID()}`;
  const document = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
  await Promise.all([
    writeArtifact(templateDraftPath, document),
    writeArtifact(publishedPath, document),
  ]);
  await db.insert(forms).values({
    createdBy: adminId,
    description: "A ready-to-share demo form with typed content controls.",
    id: formId,
    publicId: "demo-employee-intake",
    publishedKey,
    publishedPath,
    status: "published",
    templateDraftKey,
    templateDraftPath,
    title: "Demo employee intake",
    version: 1,
  });
}

export async function seedDemoAccounts(): Promise<void> {
  const adminAccount = demoAccounts.find((account) => account.role === "admin");
  if (!adminAccount) {
    throw new Error("The demo admin account is missing");
  }
  const adminId = await ensureAccount(adminAccount);
  for (const account of demoAccounts) {
    if (account !== adminAccount) {
      await ensureAccount(account);
    }
  }
  await ensureDemoForm(adminId);
}

if (import.meta.main) {
  try {
    await seedDemoAccounts();
    console.log("Demo accounts are ready");
  } finally {
    await closeDb();
  }
}
