import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [
    tanstackRouter({ autoCodeSplitting: true, target: "react" }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": path.resolve(root, "./src") } },
  server: { hmr: { clientPort: 8080 }, host: "0.0.0.0", port: 5173 },
});
