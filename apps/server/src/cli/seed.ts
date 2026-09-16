import { DEFAULT_USER_ID, ensureBaseData } from '@platform/server';
import { composeApp } from '../compose.ts';

/**
 * Fills the database with base data, explicitly.
 *
 * The application does this on its own at startup (`apps/server/src/main.ts`),
 * once per module. This command exists for the cases where that is not what you
 * want: preparing a database before the server runs — which is how the browser
 * suite builds its instances — or re-applying the fixture after deleting it.
 *
 * `--force` ignores the "already seeded" marker. The module fixtures are
 * idempotent, so a forced run adds only what is genuinely missing; it cannot
 * duplicate a record that is still there.
 */
const platform = composeApp();
const force = process.argv.includes('--force');

const result = await ensureBaseData(platform, { ownerId: DEFAULT_USER_ID, force });

for (const id of result.seeded) console.log(`[seed] modul ${id}: gotowe`);
for (const id of result.skipped) console.log(`[seed] modul ${id}: juz zasiany (uzyj --force)`);

const spaces = platform.services.canvas.listSpaces(DEFAULT_USER_ID);
console.log(`[seed] przestrzenie canvas: ${spaces.length}`);
console.log(`[seed] pliki: ${platform.services.files.list(DEFAULT_USER_ID).length}`);
platform.close();
