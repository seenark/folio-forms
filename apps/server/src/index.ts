import { createApp } from "./app";
import { ensureStorageRoot } from "./storage";

await ensureStorageRoot();

createApp().listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
