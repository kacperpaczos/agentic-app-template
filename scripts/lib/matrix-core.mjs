/**
 * Wspólny rdzeń macierzy odbioru — jedno źródło parsowania i liczenia dla bramek.
 *
 * Kanon (macierz bieżąca): wymagania czytane wprost z `docs/ARCHITECTURE.md`,
 * oceny z `docs/acceptance/assessment.json`. Nic nie jest przepisywane ręcznie:
 * zniknięcie kryterium, duplikat identyfikatora albo rozjazd stałej EXPECTED
 * daje problem w `problems` i kod wyjścia 1 w bramce, która go zbiera.
 *
 * Korzysta z niego `scripts/acceptance-matrix.mjs` (`check:acceptance`, render
 * `docs/ACCEPTANCE.md` i `docs/BACKLOG.md`) oraz `scripts/matrix-summary.mjs`
 * (`check:matrix`), więc obie bramki liczą swoje liczby tą samą arytmetyką —
 * rozjazd „dwie bramki, dwa liczenia” nie może się odtworzyć.
 *
 * Archiwum historyczne 95 kryteriów (`docs/archive/agenticapp-2026-09/`) jest
 * **osobnym światem**, świadomie oddzielonym od kanonu: parsuje je
 * `parseArchiveSpecification()`, a pilnuje `pnpm check:closure`
 * (`scripts/closure-matrix.mjs`). Łączy je tylko krzyżowa kontrola
 * `crossCheckArchive()`: pola `historical` w ocenach bieżących muszą wskazywać
 * dokładnie te 95 identyfikatorów.
 *
 * Moduł jest czysty w sensie wejścia: funkcje biorą TEKSTY (albo dane) i zwracają
 * wyniki, niczego nie czytają z dysku poza opcjonalnym sprawdzaniem istnienia
 * plików dowodowych (`opts.evidenceRoot`). Dzięki temu regresja bramek
 * (`tests/matrix-gates.test.ts`) pracuje na fixture'ach i nie rusza plików repo.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Kanon: 12 warstw, 200 kryteriów Lx.y, 27 prób Txx (docs/ARCHITECTURE.md). */
export const EXPECTED = Object.freeze({ layers: 12, criteria: 200, scenarios: 27 });

/**
 * Archiwum historyczne AgenticApp (domknięcie 2026-09-15): 12 warstw, 95 kryteriów.
 * To stała opisująca ZARCHIWIZOWANĄ wersję wymagań, nie obowiązującą specyfikację.
 */
export const EXPECTED_ARCHIVE = Object.freeze({ layers: 12, criteria: 95 });

export const STATUS = Object.freeze({
  potwierdzone: 'potwierdzone',
  czesciowe: 'częściowe',
  niespelnione: 'niespełnione',
  niesprawdzone: 'niesprawdzone',
  /*
   * Klasyfikacja właściciela 2026-09-20: kryteria **proceduralne albo
   * niewywoływalne** w tej konfiguracji — poza bramką odbioru. To nie jest
   * „potwierdzone” (brak dowodu) i nie jest otwarte (nic nie blokują): mają
   * uzasadnienie w polu braku i nie należą do żadnego pakietu backlogu, a
   * warstwy zamykają się tak, jakby ich w otwartych nie było.
   */
  informacyjne: 'informacyjne / poza bramką odbioru',
});
export const OPEN = new Set(['czesciowe', 'niespelnione', 'niesprawdzone']);
export const EVIDENCE = Object.freeze({
  model: 'rzeczywisty model',
  gui: 'test GUI bez modelu',
  test: 'test kontraktu lub logiki',
  symulacja: 'symulacja',
  kod: 'analiza kodu',
  /*
   * A recorded run of an acceptance command — `pnpm verify` on a clean copy,
   * `pnpm check:module-swap`, a probe script — with its log kept as evidence.
   * G17 allows exactly this ("skrypt odbiorowy z logiem") and none of the five
   * names above fits it: it was executed, so calling it code analysis would be
   * false, and no test file carries it.
   */
  przebieg: 'przebieg odbiorowy z logiem',
  brak: '—',
});
export const ORIGIN = Object.freeze({ szablon: 'szablon', historyczny: 'historyczny (AgenticApp)', brak: '—' });

/* ------------------------------ specyfikacja ------------------------------ */

/**
 * Parsuje obowiązującą specyfikację: warstwy `### N. tytuł`, kryteria
 * `- [ ] **Lx.y** treść`, próby z tabeli `| Txx — … |`. Identyfikator musi stać
 * na swojej pozycji warstwy (`L1.2` jako drugie kryterium L1), a EXPECTED
 * wyznacza twarde liczby: inna liczba kryteriów, warstw albo prób to problem.
 *
 * Zwraca `{ layers, criteria, scenarios, problems }`; `criteria` to Map id →
 * `{ id, text, layer }`, `scenarios` to Map id → `{ id, name, layers, positive, negative }`.
 */
export function parseSpecification(text, expected = EXPECTED) {
  const problems = [];
  const parts = text.split(/^### (\d+)\. (.+)$/m);
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
  for (const m of text.matchAll(/^\| (T\d{2}) — ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\|$/gm)) {
    const layersOf = [...m[3].matchAll(/L(\d+)/g)].map((x) => Number(x[1]));
    if (scenarios.has(m[1])) problems.push(`specyfikacja: duplikat próby ${m[1]}`);
    scenarios.set(m[1], { id: m[1], name: m[2].trim(), layers: layersOf, positive: m[4].trim(), negative: m[5].trim() });
  }
  if (layers.length !== expected.layers) problems.push(`specyfikacja: ${layers.length} warstw zamiast ${expected.layers}`);
  if (criteria.size !== expected.criteria) problems.push(`specyfikacja: ${criteria.size} kryteriów zamiast ${expected.criteria}`);
  if (scenarios.size !== expected.scenarios) problems.push(`specyfikacja: ${scenarios.size} prób zamiast ${expected.scenarios}`);
  return { layers, criteria, scenarios, problems };
}

/**
 * Parsuje plik ocen. Zgłasza czytelny błąd zamiast `SyntaxError`, żeby bramka
 * brała na siebie winę za format, nie zostawiała jej śladowi stosu.
 */
export function parseAssessment(text, nazwa = 'docs/acceptance/assessment.json') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${nazwa} nie jest poprawnym JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${nazwa} musi być obiektem z polami criteria, scenarios i backlog`);
  }
  return data;
}

/* --------------------------------- oceny ---------------------------------- */

/**
 * Wylicza macierz z pary (specyfikacja, oceny) — jedyna arytmetyka sum w repo.
 *
 * `opts.evidenceRoot`: gdy podany, sprawdzana jest istnienie plików dowodowych
 * prób względem tego katalogu (`check:acceptance` podaje korzeń repo;
 * `check:matrix` celowo nie powiela tej kontroli — to domena `check:acceptance`).
 *
 * Zwraca sumy i struktury potrzebne zarówno renderowi (`docs/ACCEPTANCE.md`),
 * jak i podsumowaniu `check:matrix`, plus `problems` w kolejności od specyfikacji
 * do prób — kolejność jest stabilna, żeby dryf był porównywalny między uruchomieniami.
 */
export function evaluateMatrix({ layers, criteria, scenarios }, data, opts = {}) {
  const problems = [];
  const backlog = new Map((data.backlog ?? []).map((b) => [b.id, { ...b, criteria: [] }]));
  const A = data.criteria ?? {};
  const S = data.scenarios ?? {};

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
    } else if (a.status === 'informacyjne') {
      /* Poza bramką, ale nie bez słowa: uzasadnienie jest obowiązkowe, pakiet
         backlogu — zakazany (kryterium poza bramką niczego nie planuje). */
      if (!a.gap || a.gap.trim() === '' || a.gap.trim() === '—') {
        problems.push(`${id}: kryterium „informacyjne” bez uzasadnienia w opisie braku`);
      }
      if (a.backlog) {
        problems.push(`${id}: kryterium „informacyjne” nie może mieć pakietu backlogu (${a.backlog})`);
      }
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

  for (const t of Object.keys(S)) if (!scenarios.has(t)) problems.push(`ocena próby ${t} bez próby w specyfikacji`);
  for (const t of scenarios.keys()) if (!S[t]) problems.push(`brak oceny próby ${t}`);

  /*
   * The index of trials, checked rather than described (BL-12).
   *
   * Every trial has to say **what kind of proof** it rests on and **which file
   * carries it** — and the file has to exist. A trial that has no evidence says
   * so with `brak`, which is a statement, not an omission: the one thing that may
   * not happen is a row that reads as evidence and points at nothing.
   */
  for (const [t, s] of scenarios) {
    const a = S[t];
    if (!a) continue;
    const kinds = a.evidence ?? [];
    if (!Array.isArray(kinds) || kinds.length === 0) {
      problems.push(`próba ${t}: brak rodzaju dowodu (pole evidence)`);
    } else {
      for (const k of kinds) if (!EVIDENCE[k]) problems.push(`próba ${t}: nieznany rodzaj dowodu "${k}"`);
    }
    const files = a.pliki ?? [];
    if (!Array.isArray(files)) problems.push(`próba ${t}: pole pliki nie jest lista`);
    else {
      for (const f of files) {
        if (opts.evidenceRoot && !existsSync(resolve(opts.evidenceRoot, f))) problems.push(`próba ${t}: dowód wskazuje nieistniejący ${f}`);
      }
      if (files.length === 0 && !kinds.includes('brak')) {
        problems.push(`próba ${t}: rodzaj dowodu podany, ale żaden plik go nie niesie`);
      }
    }
    if (a.status === 'potwierdzone' && kinds.includes('brak')) {
      problems.push(`próba ${t}: „potwierdzona” bez dowodu`);
    }
    if (!s) problems.push(`próba ${t}: brak w specyfikacji`);
  }

  const scenarioCounts = {};
  for (const t of scenarios.keys()) {
    const st = S[t]?.status ?? 'brak';
    scenarioCounts[st] = (scenarioCounts[st] ?? 0) + 1;
    if (S[t] && !STATUS[S[t].status]) problems.push(`próba ${t}: nieznany status "${S[t].status}"`);
  }
  const scenarioEvidence = {};
  for (const t of scenarios.keys()) for (const k of S[t]?.evidence ?? []) scenarioEvidence[k] = (scenarioEvidence[k] ?? 0) + 1;

  const perLayer = layers.map((L) => {
    const open = L.items.filter((c) => OPEN.has(A[c.id]?.status ?? 'niesprawdzone'));
    return { ...L, open };
  });
  const closed = perLayer.filter((l) => l.open.length === 0);

  return {
    problems,
    A,
    S,
    backlog,
    counts,
    openCriteria: [...OPEN].reduce((sum, k) => sum + (counts[k] ?? 0), 0),
    evidenceCounts,
    originCounts,
    histCounts,
    scenarioRefs,
    scenarioCounts,
    scenarioEvidence,
    perLayer,
    closed,
    total: criteria.size,
    layersCount: layers.length,
    scenariosCount: scenarios.size,
  };
}

/* ------------------------- archiwum historyczne 95 ------------------------ */

/**
 * Parsuje ARCHIWALNĄ specyfikację 95 kryteriów
 * (`docs/archive/agenticapp-2026-09/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md`).
 * Format jest starszy: kryteria bez pogrubionych identyfikatorów (`- [ ] treść`),
 * więc ID wyprowadza pozycja w warstwie — tak samo robił dawny generator macierzy.
 *
 * To parser innego świata niż `parseSpecification()`; celowo osobny, żeby zmiana
 * kanonu nie przemeblowała po cichu archiwum i odwrotnie.
 */
export function parseArchiveSpecification(text, expected = EXPECTED_ARCHIVE) {
  const problems = [];
  const parts = text.split(/^### (\d+)\. (.+)$/m);
  const layers = [];
  for (let i = 1; i < parts.length; i += 3) {
    const num = Number(parts[i]);
    const title = parts[i + 1].trim();
    const body = parts[i + 2].split(/^## /m)[0];
    const items = [...body.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1].trim());
    layers.push({ num, title, items });
  }
  const criteria = new Map();
  for (const L of layers) {
    L.items.forEach((req, idx) => {
      const id = `L${L.num}.${idx + 1}`;
      if (criteria.has(id)) problems.push(`specyfikacja archiwalna: duplikat ${id}`);
      criteria.set(id, { id, text: req, layer: L.num });
    });
  }
  if (layers.length !== expected.layers) problems.push(`specyfikacja archiwalna: ${layers.length} warstw zamiast ${expected.layers}`);
  if (criteria.size !== expected.criteria) problems.push(`specyfikacja archiwalna: ${criteria.size} kryteriów zamiast ${expected.criteria}`);
  return { layers, criteria, problems };
}

/**
 * Krzyżowa kontrola światów 95 ↔ 200 — jedyna więź między archiwum a kanonem.
 *
 * Pola `historical` w ocenach bieżących muszą być dokładnie `expected.criteria`
 * (95) i muszą wskazywać identyfikatory istniejące w specyfikacji archiwalnej;
 * symetrycznie każde kryterium archiwalne musi mieć swoje pole `historical`.
 *
 * Celowo NIE porównuje statusów: `historical` w `assessment.json` to werdykt PO
 * domknięciu (95 × „potwierdzone”), a tabele w archiwalnym `FEEDBACK.md` to
 * wcześniejszy snapshot z innym słownikiem (ZAL-R/ZAL-T/CZĘŚĆ/KOD). Mapowanie
 * między nimi byłoby zgadywaniem, a zgadywana kontrola robi fałszywe alarmy.
 */
export function crossCheckArchive(data, archiveParsed, expected = EXPECTED_ARCHIVE) {
  const problems = [];
  const criteria = data.criteria ?? {};
  const hist = Object.keys(criteria).filter((id) => criteria[id] && typeof criteria[id] === 'object' && criteria[id].historical !== undefined);
  const histSet = new Set(hist);
  if (hist.length !== expected.criteria) {
    problems.push(`oceny: ${hist.length} pól "historical" zamiast ${expected.criteria}`);
  }
  for (const id of hist) {
    if (!archiveParsed.criteria.has(id)) {
      problems.push(`oceny: pole "historical" wskazuje ${id}, którego nie ma w archiwalnej specyfikacji 95`);
    }
  }
  for (const id of archiveParsed.criteria.keys()) {
    if (!histSet.has(id)) problems.push(`oceny: kryterium archiwalne ${id} nie ma pola "historical"`);
  }
  return problems;
}

/* --------------------- raporty pochodne (wygenerowane) -------------------- */

const liczbaZRubryki = (cell) => Number(String(cell).replace(/\*/g, '').trim());

/**
 * Parsuje sekcję „Podsumowanie (wyliczone)” z WYGENEROWANEGO `docs/ACCEPTANCE.md`.
 *
 * Porównanie liczb sparsowanych z sekcji (nie surowego tekstu pliku) jest równie
 * twarde wobec dryfu, a czytelniejsze w komunikatach: „raport mówi 199, oceny
 * dają 200”. Zwraca `null`, gdy sekcji albo jej znanego kształtu nie ma — czyli
 * gdy raport jest stary, ręcznie ruszany albo wygenerowany przez inny format.
 */
export function parseAcceptanceSummary(text) {
  const START = '## Podsumowanie (wyliczone)';
  const at = text.indexOf(START);
  if (at === -1) return null;
  const rest = text.slice(at + START.length);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);

  const head = section.match(/Kryteriów w specyfikacji: \*\*(\d+)\*\* w (\d+) warstwach \(([^)]*)\); prób odbiorowych: \*\*(\d+)\*\*\./);
  if (!head) return null;

  const tables = {};
  const lines = section.split('\n');
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const block = [];
    while (i < lines.length && lines[i].startsWith('|')) block.push(lines[i++]);
    const rows = [];
    for (const l of block.slice(2)) {
      const c = cells(l);
      rows.push({ label: c[0].replace(/\*/g, ''), cells: c.slice(1) });
    }
    tables[cells(block[0])[0]] = rows;
  }
  const table = (name) => {
    const rows = tables[name];
    if (!rows || rows.some((r) => r.cells.length === 0)) return null;
    const m = new Map();
    for (const r of rows) {
      const n = liczbaZRubryki(r.cells[0]);
      if (!Number.isFinite(n)) return null;
      m.set(r.label, n);
    }
    return m;
  };

  const zamkniete = section.match(/\*\*Warstwy zamknięte — (\d+) z (\d+):\*\* ([^\n]*)\.\n/);
  const warstwy = tables['Warstwa'];
  const perLayer = warstwy
    ? warstwy.map((r) => {
        const m = r.label.match(/^L(\d+) — /);
        if (!m || r.cells.length < 3) return null;
        const otwarte = liczbaZRubryki(r.cells[1]);
        const ids = r.cells[2] === '—' ? [] : r.cells[2].split(',').map((s) => s.trim());
        const kryteria = liczbaZRubryki(r.cells[0]);
        if (!Number.isFinite(otwarte) || !Number.isFinite(kryteria) || ids.some((x) => !/^L\d+\.\d+$/.test(x))) return null;
        return { layer: Number(m[1]), kryteria, otwarte, otwarteKryteria: ids };
      })
    : null;
  if (Array.isArray(perLayer) && perLayer.some((w) => w === null)) return null;

  return {
    criteria: Number(head[1]),
    layers: Number(head[2]),
    layerItems: head[3],
    scenarios: Number(head[4]),
    statusy: table('Stan w szablonie'),
    dowody: table('Rodzaj dowodu'),
    pochodzenie: table('Pochodzenie dowodu'),
    historyczne: table('Ostatnia ocena w AgenticApp (historyczna)'),
    proby: table('Stan prób odbiorowych w szablonie'),
    dowodyProb: table('Rodzaj dowodu prób odbiorowych'),
    zamknieteLiczba: zamkniete ? Number(zamkniete[1]) : null,
    zamknieteZ: zamkniete ? Number(zamkniete[2]) : null,
    zamknieteWarstwy: zamkniete ? zamkniete[3].split(',').map((s) => s.trim()).filter((s) => s && s !== 'brak') : null,
    perLayer,
  };
}

/** Porównuje sparsowane podsumowanie raportu z liczbami wyliczonymi z ocen. */
export function compareAcceptanceSummary(parsed, ev) {
  const problems = [];
  const P = (msg) => problems.push(`raport pochodny docs/ACCEPTANCE.md rozjechany z ocenami: ${msg} — uruchom pnpm acceptance:render`);
  if (!parsed) {
    P('brak sekcji „Podsumowanie (wyliczone)” w znanym kształcie (raport stary albo ręcznie ruszany)');
    return problems;
  }
  if (parsed.criteria !== ev.total) P(`raport mówi ${parsed.criteria} kryteriów, a oceny i specyfikacja dają ${ev.total}`);
  if (parsed.layers !== ev.layersCount) P(`raport mówi ${parsed.layers} warstw, a specyfikacja daje ${ev.layersCount}`);
  if (parsed.scenarios !== ev.scenariosCount) P(`raport mówi ${parsed.scenarios} prób, a specyfikacja daje ${ev.scenariosCount}`);

  const etykietaStatusu = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));
  if (parsed.statusy) {
    for (const k of Object.keys(STATUS)) {
      const wRaporcie = parsed.statusy.get(STATUS[k]);
      const zOcen = ev.counts[k] ?? 0;
      if (wRaporcie !== undefined && wRaporcie !== zOcen) P(`status „${STATUS[k]}”: raport mówi ${wRaporcie}, a oceny dają ${zOcen}`);
    }
    const razem = parsed.statusy.get('Razem');
    if (razem !== undefined && razem !== ev.total) P(`„Razem” kryteriów: raport mówi ${razem}, a oceny dają ${ev.total}`);
  }
  if (parsed.proby) {
    for (const k of Object.keys(STATUS)) {
      const wRaporcie = parsed.proby.get(STATUS[k]);
      const zOcen = ev.scenarioCounts[k] ?? 0;
      if (wRaporcie !== undefined && wRaporcie !== zOcen) P(`próby „${STATUS[k]}”: raport mówi ${wRaporcie}, a oceny dają ${zOcen}`);
    }
    const razem = parsed.proby.get('Razem');
    if (razem !== undefined && razem !== ev.scenariosCount) P(`„Razem” prób: raport mówi ${razem}, a specyfikacja daje ${ev.scenariosCount}`);
  }

  const porownajSlownik = (wRaporcie, zOcen, etykiety, nazwa) => {
    if (!wRaporcie) return;
    const oczekiwane = new Map(Object.entries(etykiety).map(([k, label]) => [label, zOcen[k] ?? 0]));
    for (const [label, n] of wRaporcie) {
      if (label === 'Razem') continue;
      if (!oczekiwane.has(label)) {
        P(`tabela „${nazwa}” w raporcie ma wiersz „${label}”, którego nie dają oceny`);
        continue;
      }
      if (n !== oczekiwane.get(label)) P(`„${nazwa}” — ${label}: raport mówi ${n}, a oceny dają ${oczekiwane.get(label)}`);
    }
    for (const [label, n] of oczekiwane) {
      if (n > 0 && !wRaporcie.has(label)) P(`tabela „${nazwa}” w raporcie nie ma wiersza „${label}” (${n} w ocenach)`);
    }
  };
  porownajSlownik(parsed.dowody, ev.evidenceCounts, EVIDENCE, 'rodzaj dowodu');
  porownajSlownik(parsed.pochodzenie, ev.originCounts, ORIGIN, 'pochodzenie dowodu');
  porownajSlownik(parsed.dowodyProb, ev.scenarioEvidence, EVIDENCE, 'rodzaj dowodu prób');
  if (parsed.historyczne) {
    const etykiety = { ...STATUS, 'brak-oceny': 'brak oceny (kryterium spoza 95)' };
    porownajSlownik(parsed.historyczne, ev.histCounts, etykiety, 'ocena historyczna');
  }

  if (parsed.zamknieteLiczba !== null) {
    if (parsed.zamknieteLiczba !== ev.closed.length) {
      P(`warstwy zamknięte: raport mówi ${parsed.zamknieteLiczba}, a oceny dają ${ev.closed.length}`);
    }
    const raport = (parsed.zamknieteWarstwy ?? []).join(', ');
    const wyliczone = ev.closed.map((l) => `L${l.num}`).join(', ');
    if (raport !== wyliczone) P(`lista warstw zamkniętych: raport mówi „${raport || 'brak'}”, a oceny dają „${wyliczone || 'brak'}”`);
  }
  if (Array.isArray(parsed.perLayer)) {
    const zOcen = new Map(ev.perLayer.map((l) => [l.num, l]));
    if (parsed.perLayer.length !== ev.perLayer.length) {
      P(`tabela warstw: raport ma ${parsed.perLayer.length} wierszy, a specyfikacja ${ev.perLayer.length}`);
    }
    for (const w of parsed.perLayer) {
      const l = zOcen.get(w.layer);
      if (!l) {
        P(`tabela warstw: raport ma warstwę L${w.layer}, której nie ma w specyfikacji`);
        continue;
      }
      if (w.kryteria !== l.items.length) P(`L${w.layer}: raport mówi ${w.kryteria} kryteriów, a specyfikacja ${l.items.length}`);
      if (w.otwarte !== l.open.length) P(`L${w.layer}: raport mówi ${w.otwarte} otwartych, a oceny dają ${l.open.length}`);
      const ids = w.otwarteKryteria.join(', ');
      const oczekiwane = l.open.map((c) => c.id).join(', ');
      if (ids !== oczekiwane) P(`L${w.layer}: otwarte kryteria — raport mówi „${ids || '—'}”, a oceny dają „${oczekiwane || '—'}”`);
    }
  }
  return problems;
}

/**
 * Parsuje wiersz z liczbami z nagłówka WYGENEROWANEGO `docs/BACKLOG.md`:
 * „Otwartych kryteriów: **N** z T, w M pakietach.” plus zestaw pakietów
 * z nagłówków sekcji `## BL-xx — …`. Zwraca `null`, gdy kształt nieznany.
 */
export function parseBacklogSummary(text) {
  const head = text.match(/Otwartych kryteriów: \*\*(\d+)\*\* z (\d+), w (\d+) pakietach\./);
  if (!head) return null;
  const pakiety = [...text.matchAll(/^## (BL-\S+) — /gm)].map((m) => m[1]);
  return { otwarte: Number(head[1]), total: Number(head[2]), pakietyLiczba: Number(head[3]), pakiety };
}

/** Porównuje nagłówek wygenerowanego backlogu z liczbami wyliczonymi z ocen. */
export function compareBacklogSummary(parsed, ev) {
  const problems = [];
  const P = (msg) => problems.push(`raport pochodny docs/BACKLOG.md rozjechany z ocenami: ${msg} — uruchom pnpm acceptance:render`);
  if (!parsed) {
    P('brak wiersza „Otwartych kryteriów: …” w znanym kształcie (raport stary albo ręcznie ruszany)');
    return problems;
  }
  const otwarte = ev.openCriteria;
  if (parsed.otwarte !== otwarte) P(`raport mówi ${parsed.otwarte} otwartych kryteriów, a oceny dają ${otwarte}`);
  if (parsed.total !== ev.total) P(`raport mówi ${parsed.total} kryteriów, a oceny dają ${ev.total}`);
  if (parsed.pakietyLiczba !== ev.backlog.size) P(`raport mówi ${parsed.pakietyLiczba} pakietów, a oceny dają ${ev.backlog.size}`);
  const zOcen = [...ev.backlog.keys()].sort();
  const wRaporcie = [...new Set(parsed.pakiety)].sort();
  if (wRaporcie.join(', ') !== zOcen.join(', ')) {
    P(`pakiety: raport ma „${wRaporcie.join(', ') || '—'}”, a oceny dają „${zOcen.join(', ') || '—'}”`);
  }
  return problems;
}
