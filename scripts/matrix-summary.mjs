#!/usr/bin/env node
/**
 * Podsumowanie macierzy — wyliczane z KANONU, nie z raportów.
 *
 * Skrypt powstał, bo ręczne podsumowanie w archiwalnym FEEDBACK.md rozjechało się
 * z tabelami (raportował 91 kryteriów wobec 95 faktycznych, a każdy licznik per
 * status był zły). Do 2026-09-20 czytał jednak wyłącznie ARCHIWUM
 * (docs/archive/agenticapp-2026-09/FEEDBACK.md), więc obok `check:acceptance`
 * biegła druga, niewiążąca arytmetyka: 95 z archiwum obok 200 z kanonu, oba
 * zielone, bez żadnej więzi. Teraz wylicza podsumowanie macierzy BIEŻĄCEJ
 * (docs/ARCHITECTURE.md + docs/acceptance/assessment.json) tym samym rdzeniem co
 * `check:acceptance` (scripts/lib/matrix-core.mjs) i pilnuje trzech rzeczy:
 *
 *   1. twarde stałe EXPECTED (12 warstw / 200 kryteriów / 27 prób): zniknięcie
 *      kryterium z kanonu jest błędem, nie tylko mniejszą sumą;
 *   2. krzyżowa kontrola światów 95 ↔ 200: oceny mają dokładnie 95 pól
 *      `historical`, każdy z tych identyfikatorów istnieje w archiwalnej
 *      specyfikacji 95 i każde kryterium archiwalne ma swoje pole. Statusów
 *      celowo nie porównuje (patrz `crossCheckArchive` w matrix-core);
 *   3. zgodność z WYGENEROWANYMI raportami pochodnymi: liczby sparsowane z
 *      sekcji „Podsumowanie (wyliczone)” `docs/ACCEPTANCE.md` i z nagłówka
 *      `docs/BACKLOG.md` muszą równe się liczbom wyliczonym z ocen. Raport
 *      stary albo ręcznie ruszany jest błędem, nie ostrzeżeniem.
 *
 * Kontrolę samego archiwum (specyfikacja 95 ↔ oceny-95.json) prowadzi
 * `pnpm check:closure` (scripts/closure-matrix.mjs).
 *
 *   node scripts/matrix-summary.mjs           # wypisuje podsumowanie
 *   node scripts/matrix-summary.mjs --check   # jak wyżej + asercje; kod 1 przy rozjeździe
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED,
  EXPECTED_ARCHIVE,
  STATUS,
  compareAcceptanceSummary,
  compareBacklogSummary,
  crossCheckArchive,
  evaluateMatrix,
  parseAcceptanceSummary,
  parseArchiveSpecification,
  parseAssessment,
  parseBacklogSummary,
  parseSpecification,
} from './lib/matrix-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = resolve(root, 'docs/ARCHITECTURE.md');
const DATA = resolve(root, 'docs/acceptance/assessment.json');
const OUT_MATRIX = resolve(root, 'docs/ACCEPTANCE.md');
const OUT_BACKLOG = resolve(root, 'docs/BACKLOG.md');
const ARCHIVE_SPEC = resolve(root, 'docs/archive/agenticapp-2026-09/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md');

const problems = [];

const fatal = (msg) => {
  console.error(`matrix-summary: ${msg}`);
  process.exit(2);
};
const wczytaj = (p, co) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return fatal(`nie można czytać ${co}: ${p}`);
  }
};

/* ------------------------------- kanon 200 -------------------------------- */

const specText = wczytaj(SPEC, 'specyfikacji kanonu');
const { layers, criteria, scenarios, problems: specProblems } = parseSpecification(specText, EXPECTED);
problems.push(...specProblems);

let data;
try {
  data = parseAssessment(wczytaj(DATA, 'ocen kanonu'));
} catch (e) {
  fatal(e.message);
}
const ev = evaluateMatrix({ layers, criteria, scenarios }, data);
problems.push(...ev.problems);

/* ---------------------------- krzyżówka 95 ↔ 200 -------------------------- */

const archive = parseArchiveSpecification(wczytaj(ARCHIVE_SPEC, 'archiwalnej specyfikacji 95'), EXPECTED_ARCHIVE);
problems.push(...archive.problems);
problems.push(...crossCheckArchive(data, archive, EXPECTED_ARCHIVE));

/* --------------------------- raporty pochodne ----------------------------- */

const raport = parseAcceptanceSummary(wczytaj(OUT_MATRIX, 'wygenerowanego docs/ACCEPTANCE.md'));
problems.push(...compareAcceptanceSummary(raport, ev));
const backlogRaport = parseBacklogSummary(wczytaj(OUT_BACKLOG, 'wygenerowanego docs/BACKLOG.md'));
problems.push(...compareBacklogSummary(backlogRaport, ev));

/* --------------------------------- wyjście -------------------------------- */

const historical = Object.values(data.criteria ?? {}).filter((c) => c && typeof c === 'object' && c.historical !== undefined).length;
const lines = [
  `kanon: kryteria ${ev.total}, warstwy ${ev.layersCount}, próby ${ev.scenariosCount}`,
  `stan w szablonie: ${Object.keys(STATUS).map((k) => `${STATUS[k]}=${ev.counts[k] ?? 0}`).join(', ')}`,
  `warstwy zamknięte: ${ev.closed.length}/${ev.layersCount} (${ev.closed.map((l) => `L${l.num}`).join(', ') || 'brak'})`,
  `pakiety backlogu: ${ev.backlog.size}`,
  `archiwum 95: ${historical} pól "historical" w ocenach, identyfikatory zgodne ze specyfikacją archiwalną (kontrola plików: pnpm check:closure)`,
  `raporty pochodne: docs/ACCEPTANCE.md i docs/BACKLOG.md zgodne z ocenami`,
  problems.length ? `ROZJAZD (${problems.length}):\n  - ${problems.join('\n  - ')}` : 'spójność: OK',
];

console.log(lines.join('\n'));

if (!process.argv.includes('--check')) {
  console.log('\n--- tabela do wklejenia ---');
  console.log('| Stan w szablonie | Liczba |\n|---|---|');
  for (const k of Object.keys(STATUS)) console.log(`| ${STATUS[k]} | ${ev.counts[k] ?? 0} |`);
  console.log(`| **Razem** | **${ev.total}** |`);
  process.exit(0);
}

if (problems.length) {
  console.error('\nPODSUMOWANIE MACIERZY ROZJECHALO SIE Z KANONEM:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nPodsumowanie zgodne z kanonem: specyfikacja, oceny i wygenerowane raporty mówią to samo.');
