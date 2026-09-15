type JsonRecord = Record<string, unknown>;

export const deterministicExternalRecord = {
  account: {
    active: true,
    address: { city: "Bangkok", country: "TH", postalCode: "10110" },
    contact: { email: "person@example.com", phone: "+66000000000" },
    id: "account-1",
  },
  person: { birthDate: "1990-01-02", name: "Mock Person" },
} as const;

export const deterministicSchemaItems = [
  { pointer: "/account/active", type: "boolean" },
  { pointer: "/account/address/city", type: "string" },
  { pointer: "/account/address/country", type: "string" },
  { pointer: "/account/address/postalCode", type: "string" },
  { pointer: "/account/contact/email", type: "string" },
  { pointer: "/account/contact/phone", type: "string" },
  { pointer: "/account/id", type: "string" },
  { pointer: "/person/birthDate", type: "string" },
  { pointer: "/person/name", type: "string" },
] as const;

export interface ExternalPrefillHandoffInput {
  email: string;
  externalReference: string;
  publicId: string;
  values: JsonRecord;
}

export interface FolioHandoffConnector {
  createHandoff: (input: ExternalPrefillHandoffInput) => Promise<Response>;
}

export interface PrefillMockHandlerOptions {
  connector: FolioHandoffConnector;
  folioOrigin: string;
}

export interface PrefillMockServer {
  readonly url: string;
  close: () => void;
}

const htmlEscape = (value: string): string =>
  value.replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({
        '"': "&quot;",
        "&": "&amp;",
        "'": "&#39;",
        "<": "&lt;",
        ">": "&gt;",
      })[character] ?? character
  );

const jsonObject = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const formCode = async (request: Request): Promise<string | null> => {
  const form = await request.formData();
  const entries = [...form.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "code" ||
    typeof entries[0][1] !== "string"
  ) {
    return null;
  }
  return entries[0][1];
};

const launchForm = (folioOrigin: string, code: string): Response => {
  const action = `${folioOrigin.replace(/\/$/u, "")}/prefill/handoff`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Continue to Folio Forms</title></head><body><form method="post" action="${htmlEscape(action)}"><input type="hidden" name="code" value="${htmlEscape(code)}"><button type="submit">Continue to Folio Forms</button></form></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
};

export const createPrefillMockHandler =
  (
    options: PrefillMockHandlerOptions
  ): ((request: Request) => Response | Promise<Response>) =>
  async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/schema") {
      const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
      const items = query
        ? deterministicSchemaItems.filter((item) =>
            item.pointer.toLowerCase().includes(query)
          )
        : deterministicSchemaItems;
      return Response.json({ items, nextCursor: null });
    }
    if (request.method === "POST" && url.pathname === "/handoffs") {
      const input = jsonObject(await request.json());
      if (!input) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      return options.connector.createHandoff(
        input as unknown as ExternalPrefillHandoffInput
      );
    }
    if (request.method === "POST" && url.pathname === "/launch") {
      const code = await formCode(request);
      return code
        ? launchForm(options.folioOrigin, code)
        : Response.json({ error: "invalid_request" }, { status: 400 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

export const createFetchFolioConnector = (
  folioOrigin: string,
  secret: string
): FolioHandoffConnector => ({
  createHandoff: (input) =>
    fetch(
      `${folioOrigin.replace(/\/$/u, "")}/api/integrations/prefill/handoffs`,
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
          "X-Prefill-Handoff-Secret": secret,
        },
        method: "POST",
      }
    ),
});

export const createInProcessFolioConnector = (
  handle: (request: Request) => Response | Promise<Response>,
  secret: string
): FolioHandoffConnector => ({
  createHandoff: (input) =>
    Promise.resolve(
      handle(
        new Request("http://folio.local/api/integrations/prefill/handoffs", {
          body: JSON.stringify(input),
          headers: {
            "Content-Type": "application/json",
            "X-Prefill-Handoff-Secret": secret,
          },
          method: "POST",
        })
      )
    ),
});

export const startPrefillMock = (
  options: PrefillMockHandlerOptions & { port?: number }
): PrefillMockServer => {
  const server = Bun.serve({
    fetch: createPrefillMockHandler(options),
    port: options.port ?? 0,
  });
  return {
    close: () => server.stop(true),
    url: server.url.origin,
  };
};
