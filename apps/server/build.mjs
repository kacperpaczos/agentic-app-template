import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Production bundle for the backend.
 *
 * Workspace packages are TypeScript source, so they must be bundled; everything
 * from node_modules stays external (native bindings, the Claude SDK's own
 * runtime files). The result runs as plain `node dist/server.js` — no loader,
 * no experimental flag, no dev server.
 */
/*
 * Libraries bundled although they come from node_modules.
 *
 * `@openuidev/lang-core` is a dependency of `@platform/server` (the server
 * parses OpenUI compositions), not of this app. An external import of it would
 * be resolved from `apps/server/dist` at run time — where neither the workspace
 * nor the production image (`pnpm deploy` of this package) has it — so it is
 * bundled instead of being declared a second time here. Its own imports (zod)
 * stay external and resolve from this app's dependencies.
 */
const BUNDLED = ['@openuidev/lang-core'];

const externaliseNodeModules = {
  name: 'externalise-node-modules',
  setup(b) {
    b.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
      const isWorkspace = args.path.startsWith('@platform/') || args.path.startsWith('@module/');
      const isBundled = BUNDLED.some((name) => args.path === name || args.path.startsWith(`${name}/`));
      return isWorkspace || isBundled ? undefined : { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'dist/server.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  plugins: [externaliseNodeModules],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
