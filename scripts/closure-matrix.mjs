#!/usr/bin/env node
/**
 * KONTROLA ARCHIWUM HISTORYCZNEGO 95 — nie macierz bieżąca.
 *
 * Ten skrypt (`pnpm check:closure`) pilnuje spójności ARCHIWUM: historycznej
 * macierzy 95 kryteriów aplikacji AgenticApp z domknięcia 2026-09-15. Wymagania
 * są czytane wprost z archiwalnej specyfikacji
 * `docs/archive/agenticapp-2026-09/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md`,
 * nigdy przepisywane, więc kryterium nie może zniknąć ani zmienić brzmienia po
 * cichu. Oceny leżą w pliku danych
 * `docs/archive/agenticapp-2026-09/oceny-95.json` (przeniesione VERBATIM z
 * tego skryptu, wcześniej zaszyte jako obiekt `A`), a twarda stała
 * `EXPECTED_ARCHIVE` (12 warstw, 95 kryteriów) sprawia, że zniknięcie
 * kryterium jest błędem, nie tylko zmianą sumy.
 *
 * To NIE jest kontrola macierzy bieżącej szablonu: 200 kryteriów Lx.y i ich
 * oceny leżą w `docs/ARCHITECTURE.md` + `docs/acceptance/assessment.json`;
 * pilnują ich `pnpm check:acceptance` i `pnpm check:matrix`, a z archiwum 95
 * łączy je wyłącznie krzyżowa kontrola pól `historical`
 * (`scripts/lib/matrix-core.mjs`, użyta przez `check:matrix`).
 *
 * Problemy idą na STDERR: `pnpm check:closure` kieruje stdout do /dev/null,
 * więc komunikat wypisany na stdout byłby cichym, niemym failem.
 *
 *   node scripts/closure-matrix.mjs            # render markdown
 *   node scripts/closure-matrix.mjs --summary  # tylko podsumowanie
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_ARCHIVE, parseArchiveSpecification } from './lib/matrix-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_DIR = resolve(root, 'docs/archive/agenticapp-2026-09');
const ARCHIVE_SPEC = resolve(ARCHIVE_DIR, 'stack-agentowy-ustalenia-i-materialy-95-kryteriow.md');
const ARCHIVE_OCENY = resolve(ARCHIVE_DIR, 'oceny-95.json');

/* status: potwierdzone | czesciowe | niespelnione | niesprawdzone
   dowod:  przebieg | test | symulacja | kod | deklaracja | brak
   Where evidence is from the earlier build (2026-09-14) it is marked "hist.".
   Każdy wiersz oceny w oceny-95.json to dokładnie ta szóstka pól. */
const LABEL = { potwierdzone: 'potwierdzone', czesciowe: 'częściowe', niespelnione: 'niespełnione', niesprawdzone: 'niesprawdzone' };
const DOWOD = { przebieg: 'rzeczywisty przebieg', test: 'test automatyczny bez modelu', symulacja: 'symulacja', kod: 'analiza kodu', deklaracja: 'deklaracja biblioteki', brak: '—' };
const OPEN = new Set(['czesciowe', 'niespelnione', 'niesprawdzone']);

const problems = [];

/* oceny archiwalne — z pliku danych, nie z kodu */
let A = {};
try {
  const dane = JSON.parse(readFileSync(ARCHIVE_OCENY, 'utf8'));
  if (!dane || typeof dane !== 'object' || Array.isArray(dane) || !dane.oceny || typeof dane.oceny !== 'object' || Array.isArray(dane.oceny)) {
    problems.push('docs/archive/agenticapp-2026-09/oceny-95.json: brak obiektu "oceny"');
  } else {
    A = dane.oceny;
  }
} catch (e) {
  problems.push(`docs/archive/agenticapp-2026-09/oceny-95.json nie nadaje się do czytania: ${e.message}`);
}

/* specyfikacja archiwalna — parsowana, z twardą stałą 12/95 */
const doc = readFileSync(ARCHIVE_SPEC, 'utf8');
const archive = parseArchiveSpecification(doc, EXPECTED_ARCHIVE);
problems.push(...archive.problems);
const layers = archive.layers;

/* ------------------------------- renderer -------------------------------- */

const seen = new Set();
const counts = {};
const dowodCounts = {};
const perLayer = [];
const out = [];

for (const L of layers) {
  out.push(`### Warstwa ${L.num} — ${L.title}\n`);
  out.push('| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |');
  out.push('|---|---|---|---|---|---|---|---|');
  const blocking = [];
  L.items.forEach((req, idx) => {
    const id = `L${L.num}.${idx + 1}`;
    if (seen.has(id)) problems.push(`duplikat ${id}`);
    seen.add(id);
    const a = A[id];
    if (!a) { problems.push(`brak oceny dla ${id}`); return; }
    const [status, dowod, impl, proof, observed, gap] = a;
    if (!LABEL[status]) problems.push(`${id}: nieznany status archiwalny "${status}"`);
    if (!DOWOD[dowod]) problems.push(`${id}: nieznany rodzaj dowodu archiwalny "${dowod}"`);
    counts[status] = (counts[status] ?? 0) + 1;
    dowodCounts[dowod] = (dowodCounts[dowod] ?? 0) + 1;
    if (OPEN.has(status)) blocking.push(`${id} (${LABEL[status]})`);
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    out.push(`| **${id}** | ${esc(req)} | **${LABEL[status]}** | ${DOWOD[dowod]} | ${esc(impl)} | ${esc(proof)} | ${esc(observed)} | ${esc(gap)} |`);
  });
  perLayer.push({ num: L.num, title: L.title, n: L.items.length, blocking });
  out.push('');
}

for (const id of Object.keys(A)) if (!seen.has(id)) problems.push(`ocena ${id} bez odpowiednika w dokumencie`);

const total = [...seen].length;
if (total !== EXPECTED_ARCHIVE.criteria) problems.push(`archiwum: ${total} ocenionych kryteriów zamiast ${EXPECTED_ARCHIVE.criteria}`);
const closed = perLayer.filter((l) => l.blocking.length === 0);
const open = perLayer.filter((l) => l.blocking.length > 0);

const summary = [];
summary.push('### Podsumowanie macierzy\n');
summary.push(`Liczby wyliczone ze skryptu \`scripts/closure-matrix.mjs\`; wymagania czytane wprost z \`stack-agentowy-ustalenia-i-materialy.md\`.\n`);
summary.push(`**Kryteriów: ${total}** (${layers.map((l) => l.items.length).join('+')}). Dokument wymagań nie zmienił się, więc liczba jest ta sama co w audycie z 2026-09-15.\n`);
summary.push('| Stan | Liczba |');
summary.push('|---|---|');
for (const k of ['potwierdzone', 'czesciowe', 'niespelnione', 'niesprawdzone']) summary.push(`| ${LABEL[k]} | ${counts[k] ?? 0} |`);
summary.push(`| **Razem** | **${total}** |`);
summary.push('');
summary.push('| Rodzaj dowodu | Liczba |');
summary.push('|---|---|');
for (const [k, v] of Object.entries(dowodCounts).sort((a, b) => b[1] - a[1])) summary.push(`| ${DOWOD[k]} | ${v} |`);
summary.push('');
summary.push(`**Warstwy zamknięte — ${closed.length} z 12:** ${closed.map((l) => `L${l.num}`).join(', ') || 'brak'}\n`);
summary.push(`**Warstwy otwarte — ${open.length} z 12**, z identyfikatorami blokujących kryteriów:\n`);
summary.push('| Warstwa | Kryteria blokujące |');
summary.push('|---|---|');
for (const l of open) summary.push(`| L${l.num} — ${l.title} | ${l.blocking.join(', ')} |`);
summary.push('');
summary.push(`**Kontrola spójności:** ${problems.length === 0 ? 'brak brakujących i zduplikowanych identyfikatorów; każde kryterium dokumentu ma dokładnie jedną ocenę.' : problems.join('; ')}`);

/* Treść raportu idzie na stdout (bramka kieruje ją do /dev/null), problemy na
   STDERR — tylko tam `pnpm check:closure` potrai je pokazać. */
for (const p of problems) console.error(`ARCHIWUM 95: ${p}`);

if (process.argv.includes('--summary')) {
  console.log(summary.join('\n'));
} else {
  console.log(summary.join('\n'));
  console.log('\n---\n');
  console.log(out.join('\n'));
}
if (problems.length) process.exitCode = 1;
