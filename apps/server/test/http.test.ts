import { expect, test } from "bun:test";

import { db, user } from "@onlyoffice/db";
import { and, eq } from "drizzle-orm";

import { createApp } from "../src/app";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "The HTTP application test requires DATABASE_URL for an isolated PostgreSQL database"
  );
}

const app = createApp();
const jsonHeaders = { "Content-Type": "application/json" };

test("serves health and an authenticated Admin Form workflow through HTTP", async () => {
  const email = `ticket-01-${crypto.randomUUID()}@example.com`;
  const password = "Ticket01-password-for-test";
  let userId: string | undefined;
  let token: string | undefined;
  let formId: string | undefined;

  try {
    const healthResponse = await app.handle(
      new Request("http://test.local/health")
    );
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ ok: true });

    const unauthorizedResponse = await app.handle(
      new Request("http://test.local/api/admin/forms", {
        body: JSON.stringify({ title: "Denied Form" }),
        headers: jsonHeaders,
        method: "POST",
      })
    );
    expect(unauthorizedResponse.status).toBe(401);
    expect(await unauthorizedResponse.json()).toMatchObject({
      error: "unauthorized",
    });

    const signUpResponse = await app.handle(
      new Request("http://test.local/api/auth/sign-up/email", {
        body: JSON.stringify({ email, name: "Ticket 01 Admin", password }),
        headers: jsonHeaders,
        method: "POST",
      })
    );
    expect(signUpResponse.status).toBe(200);

    const createdRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    userId = createdRows[0]?.id;
    if (!userId) {
      throw new Error("The test Admin account was not created");
    }
    await db.update(user).set({ role: "admin" }).where(eq(user.id, userId));

    const signInResponse = await app.handle(
      new Request("http://test.local/api/auth/sign-in/email", {
        body: JSON.stringify({ email, password }),
        headers: jsonHeaders,
        method: "POST",
      })
    );
    expect(signInResponse.status).toBe(200);
    const signInBody = (await signInResponse.json()) as {
      session?: { token?: string };
      token?: string;
    };
    token =
      signInResponse.headers
        .get("set-auth-token")
        ?.replace(/^Bearer\s+/iu, "") ??
      signInBody.token ??
      signInBody.session?.token;
    if (!token) {
      throw new Error("The test Admin sign-in did not return a bearer token");
    }

    const createResponse = await app.handle(
      new Request("http://test.local/api/admin/forms", {
        body: JSON.stringify({
          description: "Ticket 01 HTTP proof",
          title: "Ticket 01 Form",
        }),
        headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
        method: "POST",
      })
    );
    expect(createResponse.status).toBe(200);
    const createdForm = (await createResponse.json()) as {
      form?: { id?: string; title?: string };
    };
    formId = createdForm.form?.id;
    expect(createdForm.form?.title).toBe("Ticket 01 Form");

    const listResponse = await app.handle(
      new Request("http://test.local/api/admin/forms", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      forms?: { id: string; title: string }[];
    };
    expect(
      listBody.forms?.some(
        (form) =>
          form.id === createdForm.form?.id && form.title === "Ticket 01 Form"
      )
    ).toBe(true);
  } finally {
    if (formId && token) {
      await app.handle(
        new Request(`http://test.local/api/admin/forms/${formId}`, {
          headers: { Authorization: `Bearer ${token}` },
          method: "DELETE",
        })
      );
    }
    if (userId) {
      await db
        .delete(user)
        .where(and(eq(user.id, userId), eq(user.email, email)));
    }
  }
});
