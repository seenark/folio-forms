import { ensureBootstrapAdmin } from "@onlyoffice/auth";

import { createApp, reconcileRecoverableState } from "./app";

await ensureBootstrapAdmin();
await reconcileRecoverableState();
createApp().listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
