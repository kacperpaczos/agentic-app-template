#!/usr/bin/env node
/**
 * Macierz odbioru szablonu — wyliczana, nie wpisywana ręcznie.
 *
 * Wymagania (200 kryteriów Lx.y i 27 prób Txx) są czytane wprost z
 * docs/ARCHITECTURE.md, więc kryterium nie może zniknąć ani zmienić brzmienia
 * po cichu. Ocena każdego kryterium i pakiety backlogu leżą w
 * docs/acceptance/assessment.json. Sumy, zamknięte warstwy, pokrycie prób i
 * przypisanie otwartych kryteriów do backlogu liczy wspólny rdzeń
 * scripts/lib/matrix-core.mjs — ta sama arytmetyka, z której korzysta
 * `check:matrix`, więc dwie bramki nie mogą się rozjechać.
 *
 *   node scripts/acceptance-matrix.mjs            # zapisuje docs/ACCEPTANCE.md i docs/BACKLOG.md
 *   node scripts/acceptance-matrix.mjs --check    # tylko sprawdza; kod 1 przy brakach lub dryfie plików
 *   node scripts/acceptance-matrix.mjs --summary  # wypisuje podsumowanie
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED,
  EVIDENCE,
  OPEN,
  ORIGIN,
  STATUS,
  evaluateMatrix,
  parseAssessment,
  parseSpecification,
} from './lib/matrix-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = resolve(root, 'docs/ARCHITECTURE.md');
const DATA = resolve(root, 'docs/acceptance/assessment.json');
const OUT_MATRIX = resolve(root, 'docs/ACCEPTANCE.md');
const OUT_BACKLOG = resolve(root, 'docs/BACKLOG.md');

const problems = [];

/* --------------------- specyfikacja i oceny (matrix-core) ------------------ */

const spec = readFileSync(SPEC, 'utf8');
const { layers, criteria, scenarios, problems: specProblems } = parseSpecification(spec, EXPECTED);
problems.push(...specProblems);

const data = parseAssessment(readFileSync(DATA, 'utf8'));
const ev = evaluateMatrix({ layers, criteria, scenarios }, data, { evidenceRoot: root });
problems.push(...ev.problems);

const A = ev.A;
const S = ev.S;
const backlog = ev.backlog;
const counts = ev.counts;
const evidenceCounts = ev.evidenceCounts;
const originCounts = ev.originCounts;
const histCounts = ev.histCounts;
const scenarioRefs = ev.scenarioRefs;

/* -------------------------------- render ---------------------------------- */

const esc = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const total = ev.total;
const perLayer = ev.perLayer;
const closed = ev.closed;

const meta = data.meta ?? {};
const m = [];
m.push('# Macierz odbioru szablonu');
m.push('');
m.push('> Plik generowany przez `node scripts/acceptance-matrix.mjs` z `docs/ARCHITECTURE.md` (wymagania) i');
m.push('> `docs/acceptance/assessment.json` (oceny). Nie edytuj ręcznie — `pnpm check:acceptance` wykrywa dryf.');
m.push('');
m.push(`**Stan kodu ocenianego:** ${esc(meta.codeState)}  `);
m.push(`**Data oceny:** ${esc(meta.date)}  `);
m.push(`**Charakter:** ${esc(meta.scope)}`);
m.push('');
m.push('## Podsumowanie (wyliczone)');
m.push('');
m.push(`Kryteriów w specyfikacji: **${total}** w ${layers.length} warstwach (${layers.map((l) => l.items.length).join('+')}); prób odbiorowych: **${scenarios.size}**.`);
m.push('');
m.push('| Stan w szablonie | Liczba |');
m.push('|---|---|');
for (const k of Object.keys(STATUS)) m.push(`| ${STATUS[k]} | ${counts[k] ?? 0} |`);
m.push(`| **Razem** | **${total}** |`);
m.push('');
m.push('| Rodzaj dowodu | Liczba |');
m.push('|---|---|');
for (const [k, v] of Object.entries(evidenceCounts).sort((a, b) => b[1] - a[1])) m.push(`| ${EVIDENCE[k] ?? k} | ${v} |`);
m.push('');
m.push('| Pochodzenie dowodu | Liczba |');
m.push('|---|---|');
for (const [k, v] of Object.entries(originCounts).sort((a, b) => b[1] - a[1])) m.push(`| ${ORIGIN[k] ?? k} | ${v} |`);
m.push('');
m.push('| Ostatnia ocena w AgenticApp (historyczna) | Liczba |');
m.push('|---|---|');
for (const [k, v] of Object.entries(histCounts).sort((a, b) => b[1] - a[1])) {
  m.push(`| ${STATUS[k] ?? (k === 'brak-oceny' ? 'brak oceny (kryterium spoza 95)' : k)} | ${v} |`);
}
m.push('');
m.push('| Stan prób odbiorowych w szablonie | Liczba |');
m.push('|---|---|');
for (const k of Object.keys(STATUS)) m.push(`| ${STATUS[k]} | ${ev.scenarioCounts[k] ?? 0} |`);
m.push(`| **Razem** | **${scenarios.size}** |`);
m.push('');
m.push('| Rodzaj dowodu prób odbiorowych | Liczba prób |');
m.push('|---|---|');
for (const [k, v] of Object.entries(ev.scenarioEvidence).sort((a, b) => b[1] - a[1])) m.push(`| ${EVIDENCE[k] ?? k} | ${v} |`);
m.push('');
m.push(`**Warstwy zamknięte — ${closed.length} z ${layers.length}:** ${closed.map((l) => `L${l.num}`).join(', ') || 'brak'}.`);
m.push('');
m.push('| Warstwa | Kryteria | Otwarte | Otwarte kryteria |');
m.push('|---|---|---|---|');
for (const l of perLayer) m.push(`| L${l.num} — ${esc(l.title)} | ${l.items.length} | ${l.open.length} | ${l.open.map((c) => c.id).join(', ') || '—'} |`);
m.push('');
m.push(`**Kontrola spójności:** ${problems.length === 0 ? 'każde kryterium specyfikacji ma dokładnie jedną ocenę, każda próba jest powiązana z kryterium, każde otwarte kryterium ma opis braku i pakiet backlogu.' : problems.map(esc).join('; ')}`);
m.push('');
m.push('Znaczenie pól: **Stan w szablonie** dotyczy wyłącznie dowodu uzyskanego na kodzie tego repozytorium. „Potwierdzone” wymaga takiego dowodu; wynik historyczny z AgenticApp jest pokazany osobno i sam nie zalicza kryterium (L12.10). Rodzaj dowodu nie jest statusem.');
m.push('');
m.push('## Próby odbiorowe');
m.push('');
m.push(
  'Każda próba podaje **rodzaj dowodu** i **plik, który go niesie**; kolumna „Otwarte kryteria próby” ' +
    'jest wyliczana z ocen, więc próba potwierdzona nie ukryje kryterium, które nadal jest otwarte.',
);
m.push('');
m.push('| Próba | Warstwy | Stan w szablonie | Rodzaj dowodu | Pliki z dowodem | Dowód | Braki | Powiązane kryteria | Otwarte kryteria próby |');
m.push('|---|---|---|---|---|---|---|---|---|');
for (const [t, s] of scenarios) {
  const a = S[t] ?? {};
  const kinds = (a.evidence ?? []).map((k) => EVIDENCE[k] ?? k).join(', ') || '—';
  const files = (a.pliki ?? []).map((f) => `\`${f}\``).join(', ') || '—';
  const refs = scenarioRefs.get(t);
  const openRefs = refs.filter((id) => OPEN.has(A[id]?.status ?? 'niesprawdzone'));
  m.push(
    `| **${t}** — ${esc(s.name)} | ${s.layers.map((x) => `L${x}`).join(', ')} | **${esc(STATUS[a.status] ?? a.status)}** | ${esc(kinds)} | ${esc(files)} | ${esc(a.proof)} | ${esc(a.gap)} | ${refs.join(', ') || '—'} | ${openRefs.join(', ') || '—'} |`,
  );
}
m.push('');
m.push('## Kryteria');
for (const l of perLayer) {
  m.push('');
  m.push(`### Warstwa ${l.num} — ${l.title}`);
  m.push('');
  m.push('| ID | Wymaganie (ze specyfikacji) | Stan w szablonie | Rodzaj dowodu | Zakres i odniesienie | Brak | Backlog | Próby | Ocena historyczna AgenticApp |');
  m.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of l.items) {
    const a = A[c.id] ?? {};
    const hist = a.historical ? `${STATUS[a.historical.status] ?? a.historical.status}${a.historical.note ? ` — ${a.historical.note}` : ''}` : 'brak oceny (kryterium spoza 95)';
    m.push(`| **${c.id}** | ${esc(c.text)} | **${esc(STATUS[a.status] ?? a.status)}** | ${esc(EVIDENCE[a.evidence] ?? a.evidence)} (${esc(ORIGIN[a.origin] ?? a.origin)}) | ${esc(a.proof)} | ${esc(a.gap)} | ${esc(a.backlog ?? '—')} | ${esc((a.scenarios ?? []).join(', ') || '—')} | ${esc(hist)} |`);
  }
}
m.push('');

const b = [];
b.push('# Backlog rozwoju szablonu');
b.push('');
b.push('> Plik generowany przez `node scripts/acceptance-matrix.mjs` z `docs/acceptance/assessment.json`.');
b.push('> Każde otwarte kryterium macierzy (`docs/ACCEPTANCE.md`) należy do dokładnie jednego pakietu.');
b.push('');
b.push(`Otwartych kryteriów: **${ev.openCriteria}** z ${total}, w ${backlog.size} pakietach. Kolejność pakietów jest propozycją, nie harmonogramem. Kryteria „informacyjne / poza bramką odbioru” nie są w tej liczbie — nie blokują zamknięcia warstwy ani nie należą do backlogu.`);
b.push('');
b.push('| Pakiet | Tytuł | Kryteria | Liczba |');
b.push('|---|---|---|---|');
for (const p of backlog.values()) b.push(`| ${p.id} | ${esc(p.title)} | ${p.criteria.join(', ')} | ${p.criteria.length} |`);
for (const p of backlog.values()) {
  b.push('');
  b.push(`## ${p.id} — ${p.title}`);
  b.push('');
  if (p.summary) b.push(p.summary, '');
  if (p.done) b.push(`**Warunek zamknięcia:** ${p.done}`, '');
  b.push('| ID | Wymaganie | Stan | Brak |');
  b.push('|---|---|---|---|');
  for (const id of p.criteria) {
    const a = A[id];
    b.push(`| ${id} | ${esc(criteria.get(id).text)} | ${STATUS[a.status]} | ${esc(a.gap)} |`);
  }
}
b.push('');

const matrixText = m.join('\n');
const backlogText = b.join('\n');

const summary = [
  `kryteria: ${total}, warstwy: ${layers.length}, próby: ${scenarios.size}`,
  `stan w szablonie: ${Object.keys(STATUS).map((k) => `${STATUS[k]}=${counts[k] ?? 0}`).join(', ')}`,
  `warstwy zamknięte: ${closed.length}/${layers.length}`,
  `pakiety backlogu: ${backlog.size}`,
  problems.length ? `PROBLEMY (${problems.length}):\n  - ${problems.join('\n  - ')}` : 'spójność: OK',
].join('\n');

if (process.argv.includes('--check')) {
  const drift = [];
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  if (read(OUT_MATRIX) !== matrixText) drift.push('docs/ACCEPTANCE.md nie odpowiada ocenom — uruchom node scripts/acceptance-matrix.mjs');
  if (read(OUT_BACKLOG) !== backlogText) drift.push('docs/BACKLOG.md nie odpowiada ocenom — uruchom node scripts/acceptance-matrix.mjs');
  console.log(summary);
  for (const d of drift) console.error(`DRYF: ${d}`);
  if (problems.length || drift.length) process.exitCode = 1;
} else if (process.argv.includes('--summary')) {
  console.log(summary);
  if (problems.length) process.exitCode = 1;
} else {
  writeFileSync(OUT_MATRIX, matrixText);
  writeFileSync(OUT_BACKLOG, backlogText);
  console.log(summary);
  if (problems.length) process.exitCode = 1;
}
