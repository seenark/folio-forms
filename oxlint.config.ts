import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: [
        "apps/web/src/routes/admin/forms/$formId.tsx",
        "apps/web/src/routes/admin/forms/$formId/submissions/$submissionId.tsx",
        "apps/web/src/routes/receipt/$submissionId.tsx",
      ],
      rules: {
        "unicorn/filename-case": "off",
      },
    },
  ],
});
