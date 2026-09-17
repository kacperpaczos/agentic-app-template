#!/usr/bin/env node
/**
 * Writes the server's copy of the ready-made OpenUI catalog's JSON Schema.
 *
 * Why a copy exists at all: the server validates every OpenUI composition
 * before it is stored (`packages/platform-server/src/registry/openui-validation.ts`),
 * and the OpenUI Lang parser needs each component's parameter list to map
 * positional arguments to props. The ready-made components live in
 * `@openuidev/react-ui`, a React package the server must not import. So the
 * server reads the same schema the browser's `openuiLibrary.toJSONSchema()`
 * produces, from this generated file.
 *
 * The copy cannot drift silently: `tests/openui-catalog-parity.test.ts` compares
 * it, component by component, with the browser library. When `@openuidev/react-ui`
 * is upgraded, run `node scripts/openui-library-schema.mjs` and review the diff.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiRequire = createRequire(resolve(root, 'packages/platform-ui/package.json'));
const { openuiLibrary } = await import(uiRequire.resolve('@openuidev/react-ui'));

const schema = openuiLibrary.toJSONSchema();
const out = {
  $comment:
    'Wygenerowane przez scripts/openui-library-schema.mjs z openuiLibrary (@openuidev/react-ui). Nie edytuj recznie.',
  root: openuiLibrary.root,
  $defs: schema.$defs,
};
const target = resolve(root, 'packages/platform-server/src/registry/openui-library.schema.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`[openui] zapisano ${Object.keys(out.$defs).length} komponentow do ${target}`);
