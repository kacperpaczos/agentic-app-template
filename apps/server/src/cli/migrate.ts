import { composeApp } from '../compose.ts';

const platform = composeApp();
const rows = platform.db.$client.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>;
console.log(`[migrate] baza: ${platform.config.dbFile}`);
console.log(`[migrate] zastosowane migracje (${rows.length}):`);
for (const r of rows) console.log(`  - ${r.id}`);
platform.close();
