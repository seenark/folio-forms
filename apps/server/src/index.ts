import { ensureBootstrapAdmin } from "@onlyoffice/auth";

import { createApp } from "./app";

await ensureBootstrapAdmin();
createApp().listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
