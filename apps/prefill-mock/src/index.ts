import { createFetchFolioConnector, createPrefillMockHandler } from "./mock";

const folioOrigin = process.env.FOLIO_ORIGIN ?? "http://localhost:3000";
const secret = process.env.PREFILL_HANDOFF_SECRET;
if (!secret || secret.length < 32) {
  throw new Error("PREFILL_HANDOFF_SECRET must contain at least 32 characters");
}

Bun.serve({
  fetch: createPrefillMockHandler({
    connector: createFetchFolioConnector(folioOrigin, secret),
    folioOrigin,
  }),
  port: Number(process.env.PREFILL_MOCK_PORT ?? 3010),
});
