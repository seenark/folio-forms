# Frontend setup research: React + TanStack Router + Vite + Tailwind + shadcn/ui

Source-verified future implementation guide for adding a React SPA at `apps/web` to this Bun/Turborepo workspace. Research only; commands below have not been run here.

## Facts and recommendations

TanStack's Router-only scaffold is an SPA, and file-based routing is recommended. [CLI README](https://github.com/TanStack/cli#readme) · [file-based routing](https://tanstack.com/router/latest/docs/routing/file-based-routing)

The scaffold creates a project directory, not an in-place migration. The CLI documents `--target-dir` and `--force`, so generation can be aimed at `apps/web`; `--force` permits overwrite. For a non-empty app, use manual integration. [CLI reference](https://tanstack.com/cli/latest/docs/cli-reference#tanstack-create) · [existing project](https://tanstack.com/router/latest/docs/quick-start#existing-project)

**Recommendation (not documented fact):** choose shadcn's current `base` library, a preset selected in shadcn/create, `neutral` base color, Lucide icons, CSS variables enabled, and RTL disabled unless product requirements differ. CLI controls are documented; style/base color cannot change after initialization. [CLI](https://ui.shadcn.com/docs/cli#init) · [components.json](https://ui.shadcn.com/docs/components-json)

## Procedure

### 1. Workspace boundary

Keep the app at `apps/web` with its own `package.json`. Bun discovers directories named by root `workspaces`; each workspace has its own manifest and `bun install` installs all workspaces. Turborepo's conventional layout is `apps/*` plus `packages/*`, with package manifests and root `turbo.json`. [Bun workspaces](https://bun.com/docs/pm/workspaces) · [Turborepo structure](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository)

### 2. Scaffold safely

Preferred explicit path for a new empty app directory:

```sh
bun create vite apps/web --template react-ts
cd apps/web
bun add @tanstack/react-router
bun add -d @tanstack/router-plugin @vitejs/plugin-react vite typescript
```

Vite documents `bun create` and `react-ts`. TanStack's existing-project guide requires React 18+ and ReactDOM and installs `@tanstack/react-router`; its Vite guide requires `@tanstack/router-plugin`. [Vite](https://vite.dev/guide/#scaffolding-your-first-vite-project) · [Router quick start](https://tanstack.com/router/latest/docs/quick-start#existing-project) · [Router Vite](https://tanstack.com/router/latest/docs/installation/with-vite)

Official scaffold (only for a disposable/empty target):

```sh
bunx @tanstack/cli create web --target-dir apps/web --router-only --package-manager bun --no-git
```

Documented syntax is `tanstack create [project-name] [options]`, including `router-only`, `package-manager`, `target-dir`, `no-git`, `no-install`, and `force`. If target is non-empty, the reference says `force` is required or creation exits; never add it casually. README examples use `npx`; `bunx` is the Bun invocation and `--package-manager bun` aligns generated metadata. [CLI reference](https://tanstack.com/cli/latest/docs/cli-reference#tanstack-create) · [CLI README](https://github.com/TanStack/cli#readme)

### 3. Vite and file-based route generation

In `apps/web/vite.config.ts`, preserve React and put Router before React:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
  ],
});
```

This ordering/options are documented verbatim. Defaults are `./src/routes`, `./src/routeTree.gen.ts`, ignore prefix `-`, and single quotes. [Router Vite](https://tanstack.com/router/latest/docs/installation/with-vite#react)

Create `src/routes/__root.tsx` and `src/routes/index.tsx`. The plugin generates `src/routeTree.gen.ts` during dev/build; do not hand-edit it. `__root.tsx` is root, `index.tsx` is `/`, `about.tsx` is `/about`; directories/dots nest routes and `$param` denotes dynamic segments. Exclude generated output from formatter/linter/search tooling. [File-based routing](https://tanstack.com/router/latest/docs/routing/file-based-routing) · [generated tree](https://tanstack.com/router/latest/docs/installation/with-vite#ignoring-the-generated-route-tree-file)

Use Vite's package scripts:

```json
"scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" }
```

Register package tasks in the existing root Turborepo task graph rather than root shell choreography. [Vite CLI](https://vite.dev/guide/#command-line-interface) · [Turborepo](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository)

### 4. Tailwind v4

```sh
bun add tailwindcss @tailwindcss/vite
```

Add `tailwindcss()` to Vite plugins and put this in the stylesheet imported by the entry point (usually `src/index.css`):

```css
@import "tailwindcss";
```

This is Tailwind's official Vite procedure: those packages, the Vite plugin, the import, then the dev script. [Tailwind Vite](https://tailwindcss.com/docs/installation/using-vite)

### 5. shadcn/ui initialization

For an existing Vite app, configure Tailwind and `@/*` in both `tsconfig.json` and `tsconfig.app.json`, configure Vite's alias, then initialize:

```sh
bun add -d @types/node
bunx shadcn@latest init --cwd apps/web --template vite
```

From `apps/web`, omit `--cwd apps/web`. Supported controls include `cwd`, `template vite`, `base`, `preset`, `css-variables`, `rtl`, and `force`. [shadcn Vite existing project](https://ui.shadcn.com/docs/installation/vite#existing-project) · [shadcn CLI](https://ui.shadcn.com/docs/cli#init)

For Tailwind v4, `components.json` must leave `tailwind.config` empty. Keep `tailwind.css` pointing to the importing stylesheet, enable CSS variables, and use aliases matching the app:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "tsx": true,
  "rsc": false,
  "aliases": {
    "components": "@/components",
    "hooks": "@/hooks",
    "lib": "@/lib",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

Retain exact style/icon fields selected by init/preset; do not guess them. CLI aliases are required and must agree with TypeScript paths and Vite alias. [components.json](https://ui.shadcn.com/docs/components-json) · [shadcn Vite](https://ui.shadcn.com/docs/installation/vite#existing-project)

### 6. Add components

```sh
bunx shadcn@latest add card --cwd apps/web
```

Or `cd apps/web` and omit cwd. `add` installs source files/dependencies; `--dry-run`, `--diff`, and `--overwrite` are documented for review/controlled replacement. Components are source code imported through aliases, e.g. `@/components/ui/card`. [shadcn CLI add](https://ui.shadcn.com/docs/cli#add) · [shadcn Vite](https://ui.shadcn.com/docs/installation/vite#use-shadcncreate)

### 7. Optional shared UI workspace

shadcn monorepo mode creates `apps/web` and `packages/ui`, requires `components.json` in every workspace, and routes shared components to `packages/ui` with imports such as `@workspace/ui/components/button`. Tailwind v4 leaves config empty in both files. [shadcn monorepo](https://ui.shadcn.com/docs/monorepo)

This assignment asks for `apps/web`, not new `packages/ui` architecture; initialize directly in the app first. If shared UI is later chosen, add an explicit Bun workspace dependency using `workspace:*` and exports. [Bun workspace protocol](https://bun.com/docs/pm/workspaces)

## Risks and unresolved compatibility

1. Generator overwrite: `force` is the documented overwrite switch; never aim it at repository root.
2. CLI drift: `@tanstack/cli` and `shadcn@latest` move independently; pin versions during implementation after compatibility review.
3. Generated tree: `routeTree.gen.ts` is managed output and may transiently show editor errors after renames.
4. Alias mismatch: TypeScript, Vite, and `components.json` must resolve the same `@/*` to `src`.
5. Tailwind mixing: v4 uses `@tailwindcss/vite` and blank config metadata; do not copy v3 config/content-glob instructions.
6. Turbo: add app scripts to existing task definitions; exact root config is intentionally not prescribed.
7. SPA deployment: the eventual static host needs history fallback to `index.html`; hosting-specific rewrite configuration is unresolved by cited sources.

## Primary source index

- TanStack Router: https://tanstack.com/router/latest/docs/quick-start · https://tanstack.com/router/latest/docs/installation/with-vite · https://tanstack.com/router/latest/docs/routing/file-based-routing
- TanStack CLI: https://tanstack.com/cli/latest/docs/cli-reference · https://github.com/TanStack/cli#readme
- Vite: https://vite.dev/guide/
- Tailwind: https://tailwindcss.com/docs/installation/using-vite
- shadcn/ui: https://ui.shadcn.com/docs/installation/vite · https://ui.shadcn.com/docs/monorepo · https://ui.shadcn.com/docs/cli · https://ui.shadcn.com/docs/components-json
- Bun: https://bun.com/docs/pm/workspaces
- Turborepo: https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository
