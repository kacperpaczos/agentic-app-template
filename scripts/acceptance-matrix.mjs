#!/usr/bin/env node
/**
 * Macierz odbioru szablonu — wyliczana, nie wpisywana ręcznie.
 *
 * Wymagania (200 kryteriów Lx.y i 27 prób Txx) są czytane wprost z
 * docs/ARCHITECTURE.md, więc kryterium nie może zniknąć ani zmienić brzmienia
 * po cichu. Ocena każdego kryterium i pakiety backlogu leżą w
 * docs/acceptance/assessment.json. Sumy, zamknięte warstwy, pokrycie prób i
 * przypisanie otwartych kryteriów do backlogu liczy ten skrypt.
 *
 *   node scripts/acceptance-matrix.mjs            # zapisuje docs/ACCEPTANCE.md i docs/BACKLOG.md
 *   node scripts/acceptance-matrix.mjs --check    # tylko sprawdza; kod 1 przy brakach lub dryfie plików
 *   node scripts/acceptance-matrix.mjs --summary  # wypisuje podsumowanie
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = resolve(root, 'docs/ARCHITECTURE.md');
const DATA = resolve(root, 'docs/acceptance/assessment.json');
const OUT_MATRIX = resolve(root, 'docs/ACCEPTANCE.md');
const OUT_BACKLOG = resolve(root, 'docs/BACKLOG.md');

const EXPECTED = { layers: 12, criteria: 200, scenarios: 27 };

const STATUS = {
  potwierdzone: 'potwierdzone',
  czesciowe: 'częściowe',
  niespelnione: 'niespełnione',
  niesprawdzone: 'niesprawdzone',
};
const OPEN = new Set(['czesciowe', 'niespelnione', 'niesprawdzone']);
const EVIDENCE = {
  model: 'rzeczywisty model',
  gui: 'test GUI bez modelu',
  test: 'test kontraktu lub logiki',
  symulacja: 'symulacja',
  kod: 'analiza kodu',
  brak: '—',
};
const ORIGIN = { szablon: 'szablon', historyczny: 'historyczny (AgenticApp)', brak: '—' };

const problems = [];

/* ------------------------------ specyfikacja ------------------------------ */

const spec = readFileSync(SPEC, 'utf8');
const parts = spec.split(/^### (\d+)\. (.+)$/m);
const layers = [];
for (let i = 1; i < parts.length; i += 3) {
  const num = Number(parts[i]);
  const body = parts[i + 2].split(/^## /m)[0];
  const items = [...body.matchAll(/^- \[ \] \*\*(L\d+\.\d+)\*\* (.+)$/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
  if (items.length === 0) continue;
  layers.push({ num, title: parts[i + 1].trim(), items });
}
const criteria = new Map();
for (const L of layers) {
  L.items.forEach((c, idx) => {
    const expectedId = `L${L.num}.${idx + 1}`;
    if (c.id !== expectedId) problems.push(`specyfikacja: ${c.id} na pozycji ${expectedId}`);
    if (criteria.has(c.id)) problems.push(`specyfikacja: duplikat ${c.id}`);
    criteria.set(c.id, { ...c, layer: L.num });
  });
}
const scenarios = new Map();
for (const m of spec.matchAll(/^\| (T\d{2}) — ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\|$/gm)) {
  const layersOf = [...m[3].matchAll(/L(\d+)/g)].map((x) => Number(x[1]));
  if (scenarios.has(m[1])) problems.push(`specyfikacja: duplikat próby ${m[1]}`);
  scenarios.set(m[1], { id: m[1], name: m[2].trim(), layers: layersOf, positive: m[4].trim(), negative: m[5].trim() });
}
if (layers.length !== EXPECTED.layers) problems.push(`specyfikacja: ${layers.length} warstw zamiast ${EXPECTED.layers}`);
if (criteria.size !== EXPECTED.criteria) problems.push(`specyfikacja: ${criteria.size} kryteriów zamiast ${EXPECTED.criteria}`);
if (scenarios.size !== EXPECTED.scenarios) problems.push(`specyfikacja: ${scenarios.size} prób zamiast ${EXPECTED.scenarios}`);

/* --------------------------------- oceny ---------------------------------- */

const data = JSON.parse(readFileSync(DATA, 'utf8'));
const backlog = new Map((data.backlog ?? []).map((b) => [b.id, { ...b, criteria: [] }]));
const A = data.criteria ?? {};

for (const id of Object.keys(A)) if (!criteria.has(id)) problems.push(`ocena ${id} bez kryterium w specyfikacji`);

const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
const evidenceCounts = {};
const originCounts = {};
const histCounts = {};
const scenarioRefs = new Map([...scenarios.keys()].map((k) => [k, []]));

for (const [id, c] of criteria) {
  const a = A[id];
  if (!a) {
    problems.push(`brak oceny ${id}`);
    continue;
  }
  if (!STATUS[a.status]) problems.push(`${id}: nieznany status "${a.status}"`);
  if (!EVIDENCE[a.evidence]) problems.push(`${id}: nieznany rodzaj dowodu "${a.evidence}"`);
  if (!ORIGIN[a.origin]) problems.push(`${id}: nieznane pochodzenie dowodu "${a.origin}"`);
  if (a.status === 'potwierdzone' && a.origin !== 'szablon') {
    problems.push(`${id}: „potwierdzone” wymaga dowodu z szablonu, nie historycznego`);
  }
  if (a.status === 'potwierdzone' && a.evidence === 'brak') problems.push(`${id}: „potwierdzone” bez rodzaju dowodu`);
  if (OPEN.has(a.status)) {
    if (!a.gap || a.gap.trim() === '' || a.gap.trim() === '—') problems.push(`${id}: otwarte kryterium bez opisu braku`);
    if (!a.backlog) problems.push(`${id}: otwarte kryterium bez pakietu backlogu`);
    else if (!backlog.has(a.backlog)) problems.push(`${id}: nieznany pakiet backlogu ${a.backlog}`);
    else backlog.get(a.backlog).criteria.push(id);
  } else if (a.backlog) {
    problems.push(`${id}: potwierdzone kryterium przypisane do backlogu ${a.backlog}`);
  }
  for (const t of a.scenarios ?? []) {
    const s = scenarios.get(t);
    if (!s) problems.push(`${id}: nieznana próba ${t}`);
    else {
      if (!s.layers.includes(c.layer)) problems.push(`${id}: próba ${t} nie obejmuje warstwy L${c.layer}`);
      scenarioRefs.get(t).push(id);
    }
  }
  counts[a.status] = (counts[a.status] ?? 0) + 1;
  evidenceCounts[a.evidence] = (evidenceCounts[a.evidence] ?? 0) + 1;
  originCounts[a.origin] = (originCounts[a.origin] ?? 0) + 1;
  const h = a.historical?.status ?? 'brak-oceny';
  histCounts[h] = (histCounts[h] ?? 0) + 1;
}
for (const [t, refs] of scenarioRefs) if (refs.length === 0) problems.push(`próba ${t} nie jest powiązana z żadnym kryterium`);
for (const b of backlog.values()) if (b.criteria.length === 0) problems.push(`pakiet backlogu ${b.id} bez kryteriów`);

const S = data.scenarios ?? {};
for (const t of Object.keys(S)) if (!scenarios.has(t)) problems.push(`ocena próby ${t} bez próby w specyfikacji`);
for (const t of scenarios.keys()) if (!S[t]) problems.push(`brak oceny próby ${t}`);

/* -------------------------------- render ---------------------------------- */

const esc = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const total = criteria.size;
const perLayer = layers.map((L) => {
  const open = L.items.filter((c) => OPEN.has(A[c.id]?.status ?? 'niesprawdzone'));
  return { ...L, open };
});
const closed = perLayer.filter((l) => l.open.length === 0);

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
const scenarioCounts = {};
for (const t of scenarios.keys()) {
  const st = S[t]?.status ?? 'brak';
  scenarioCounts[st] = (scenarioCounts[st] ?? 0) + 1;
  if (S[t] && !STATUS[S[t].status]) problems.push(`próba ${t}: nieznany status "${S[t].status}"`);
}
m.push('| Stan prób odbiorowych w szablonie | Liczba |');
m.push('|---|---|');
for (const k of Object.keys(STATUS)) m.push(`| ${STATUS[k]} | ${scenarioCounts[k] ?? 0} |`);
m.push(`| **Razem** | **${scenarios.size}** |`);
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
m.push('| Próba | Warstwy | Stan w szablonie | Dowód | Braki | Powiązane kryteria |');
m.push('|---|---|---|---|---|---|');
for (const [t, s] of scenarios) {
  const a = S[t] ?? {};
  m.push(`| **${t}** — ${esc(s.name)} | ${s.layers.map((x) => `L${x}`).join(', ')} | **${esc(STATUS[a.status] ?? a.status)}** | ${esc(a.proof)} | ${esc(a.gap)} | ${scenarioRefs.get(t).join(', ') || '—'} |`);
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
b.push(`Otwartych kryteriów: **${total - counts.potwierdzone}** z ${total}, w ${backlog.size} pakietach. Kolejność pakietów jest propozycją, nie harmonogramem.`);
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
