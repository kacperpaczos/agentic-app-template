import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regresja bramek macierzowych — na rdzeniu (scripts/lib/matrix-core.mjs) i na
 * trzech bramkach w tym drzewie.
 *
 * Kontrola negatywna jest tu treścią testu, nie ozdobą: każde oblewanie ma
 * asercję mówiącą, ZA CO oblewa (konkretny komunikat problemu), żeby zielony
 * wynik nie wynikał z tego, że kontrola przypadkiem niczego nie obejrzała, a
 * czerwony — z powodu innego niż badany. Wszystko pracuje na fixture'ach
 * (stringi budowane w teście); **żaden test nie mutuje plików repo** — pliki
 * kanonu są tym, co bramki pilnują, więc test, który je przepisywałby, by
 * sam stracił wiarygodność. Jedyny test uruchamiający procesy w repo to smoke:
 * trzy bramki w trybie --check na obecnym, zatwierdzonym stanie.
 */

const REPO = resolve(import.meta.dirname, '..');
const CORE = resolve(REPO, 'scripts/lib/matrix-core.mjs');

interface Expected {
  layers: number;
  criteria: number;
  scenarios: number;
}
interface ExpectedArchive {
  layers: number;
  criteria: number;
}
interface Kryterium {
  id: string;
  text: string;
  layer: number;
}
interface Warstwa {
  num: number;
  title: string;
  items: { id: string; text: string }[];
}
interface Proba {
  id: string;
  name: string;
  layers: number[];
  positive: string;
  negative: string;
}
interface Wyliczenie {
  problems: string[];
  counts: Record<string, number>;
  openCriteria: number;
  scenarioCounts: Record<string, number>;
  evidenceCounts: Record<string, number>;
  originCounts: Record<string, number>;
  histCounts: Record<string, number>;
  total: number;
  layersCount: number;
  scenariosCount: number;
  closed: { num: number }[];
  perLayer: { num: number; title: string; items: Kryterium[]; open: Kryterium[] }[];
  backlog: Map<string, { id: string; criteria: string[] }>;
}
interface RaportPochodny {
  criteria: number;
  layers: number;
  scenarios: number;
  statusy: Map<string, number> | null;
  zamknieteLiczba: number | null;
  zamknieteWarstwy: string[] | null;
  perLayer: { layer: number; kryteria: number; otwarte: number; otwarteKryteria: string[] }[] | null;
}

interface MatrixCore {
  EXPECTED: Expected;
  EXPECTED_ARCHIVE: ExpectedArchive;
  STATUS: Record<string, string>;
  parseSpecification: (text: string, expected?: Expected) => {
    layers: Warstwa[];
    criteria: Map<string, Kryterium>;
    scenarios: Map<string, Proba>;
    problems: string[];
  };
  parseAssessment: (text: string, nazwa?: string) => Record<string, unknown>;
  evaluateMatrix: (spec: { layers: Warstwa[]; criteria: Map<string, Kryterium>; scenarios: Map<string, Proba> }, data: unknown, opts?: { evidenceRoot?: string }) => Wyliczenie;
  parseArchiveSpecification: (text: string, expected?: ExpectedArchive) => {
    layers: { num: number; title: string; items: string[] }[];
    criteria: Map<string, Kryterium>;
    problems: string[];
  };
  crossCheckArchive: (data: unknown, archive: { criteria: Map<string, Kryterium> }, expected?: ExpectedArchive) => string[];
  parseAcceptanceSummary: (text: string) => RaportPochodny | null;
  compareAcceptanceSummary: (parsed: RaportPochodny | null, ev: Wyliczenie) => string[];
  parseBacklogSummary: (text: string) => { otwarte: number; total: number; pakietyLiczba: number; pakiety: string[] } | null;
  compareBacklogSummary: (parsed: ReturnType<MatrixCore['parseBacklogSummary']>, ev: Wyliczenie) => string[];
}

const core = (await import(CORE)) as MatrixCore;

/* ------------------------------- fixture'y -------------------------------- */

/** Specyfikacja w formacie docs/ARCHITECTURE.md: `### N. tytuł` + `- [ ] **Lx.y** …`. */
const specZ = (warstwy: Record<number, string[]>): string =>
  Object.entries(warstwy)
    .map(([num, items]) => `### ${num}. Warstwa ${num}\n\n${items.map((id) => `- [ ] **${id}** wymaganie ${id}`).join('\n')}\n`)
    .join('\n');

/** Oceny w formacie docs/acceptance/assessment.json, z rozsądnymi domyślnymi. */
const ocenyZ = (wpisy: Record<string, Record<string, unknown>>): Record<string, unknown> => ({
  criteria: Object.fromEntries(
    Object.entries(wpisy).map(([id, w]) => [
      id,
      { status: 'potwierdzone', evidence: 'test', origin: 'szablon', proof: 'dowód', gap: '—', scenarios: [], ...w },
    ]),
  ),
  scenarios: {},
  backlog: [],
});

const MALE_EXPECTED: Expected = { layers: 2, criteria: 3, scenarios: 0 };
const KANON = specZ({ 1: ['L1.1', 'L1.2'], 2: ['L2.1'] });
const OCENY = ocenyZ({
  'L1.1': {},
  'L1.2': { status: 'czesciowe', gap: 'brak dowodu', backlog: 'BL-01' },
  'L2.1': {},
});
const OCENY_BACKLOG = [{ id: 'BL-01', title: 'Pakiet przykładowy' }];

const wylicz = (spec: string, data: unknown) => {
  const parsed = core.parseSpecification(spec, MALE_EXPECTED);
  expect(parsed.problems, `fixture specyfikacji ma być czysty, a daje: ${parsed.problems.join('; ')}`).toEqual([]);
  const ev = core.evaluateMatrix(parsed, data);
  return ev;
};

/** Sekcja „Podsumowanie (wyliczone)” w formacie generowanego docs/ACCEPTANCE.md. */
const raportZ = (stany: Record<string, number>, total: number, warstwy: { num: number; kryteria: number; otwarte: number; ids: string }[], zamkniete: string): string =>
  [
    '# Macierz',
    '',
    '## Podsumowanie (wyliczone)',
    '',
    `Kryteriów w specyfikacji: **${total}** w ${warstwy.length} warstwach (${warstwy.map((w) => w.kryteria).join('+')}); prób odbiorowych: **0**.`,
    '',
    '| Stan w szablonie | Liczba |',
    '|---|---|',
    `| potwierdzone | ${stany.potwierdzone} |`,
    `| częściowe | ${stany['częściowe'] ?? 0} |`,
    `| niespełnione | ${stany['niespełnione'] ?? 0} |`,
    `| niesprawdzone | ${stany.niesprawdzone ?? 0} |`,
    `| **Razem** | **${total}** |`,
    '',
    `**Warstwy zamknięte — ${zamkniete === 'brak' ? 0 : zamkniete.split(', ').length} z ${warstwy.length}:** ${zamkniete}.`,
    '',
    '| Warstwa | Kryteria | Otwarte | Otwarte kryteria |',
    '|---|---|---|---|',
    ...warstwy.map((w) => `| L${w.num} — Warstwa ${w.num} | ${w.kryteria} | ${w.otwarte} | ${w.ids || '—'} |`),
    '',
    '## Próby odbiorowe',
    '',
  ].join('\n');

/* --------------------- rdzeń: kontrola negatywna (unit) -------------------- */

describe('rdzeń macierzy: kontrola negatywna na fixture\'ach', () => {
  it('1. usunięcie jednego kryterium oblewa: liczba, pozycja i osierocona ocena', () => {
    const bezL12 = specZ({ 1: ['L1.1'], 2: ['L2.1'] });

    const parsed = core.parseSpecification(bezL12, MALE_EXPECTED);
    expect(parsed.problems, 'specyfikacja z 2 kryteriami musi oblać stałą 3').toContain('specyfikacja: 2 kryteriów zamiast 3');

    const ev = core.evaluateMatrix(parsed, { ...OCENY, backlog: OCENY_BACKLOG });
    expect(ev.problems, 'ocena L1.2 musi zostać wykryta jako osierocona').toContain('ocena L1.2 bez kryterium w specyfikacji');
    expect(ev.problems, 'pakiet bez kryteriów (przypisanie wisiało na usuniętym kryterium) ma oblać').toContain('pakiet backlogu BL-01 bez kryteriów');
  });

  it('2. zmiana statusu oceny oblewa, a dryf wygenerowanego dokumentu też oblewa', () => {
    const przed = wylicz(KANON, { ...OCENY, backlog: OCENY_BACKLOG });
    expect(przed.problems, 'stan wyjściowy fixture ma być spójny').toEqual([]);
    expect(przed.counts.potwierdzone).toBe(2);
    expect(przed.counts.czesciowe).toBe(1);

    const raport = core.parseAcceptanceSummary(
      raportZ({ potwierdzone: 2, 'częściowe': 1 }, 3, [
        { num: 1, kryteria: 2, otwarte: 1, ids: 'L1.2' },
        { num: 2, kryteria: 1, otwarte: 0, ids: '' },
      ], 'L2'),
    );
    expect(raport, 'raport zgodny z ocenami ma się parsować').not.toBeNull();
    expect(core.compareAcceptanceSummary(raport, przed), 'raport z liczbami ocen ma PRZECHODZIĆ (kontrola pozytywna)').toEqual([]);

    /* Ta sama specyfikacja, ocena L1.2 cofnięta do „niesprawdzone”: jedyna
       zmiana to status, więc jedynym powodem oblania jest dryf raportu. */
    const po = wylicz(KANON, {
      ...ocenyZ({ 'L1.1': {}, 'L1.2': { status: 'niesprawdzone', gap: 'brak dowodu', backlog: 'BL-01' }, 'L2.1': {} }),
      backlog: OCENY_BACKLOG,
    });
    expect(po.problems, 'zmiana statusu na dopuszczalny nie może tworzyć niespójności ocen').toEqual([]);
    expect(po.counts.potwierdzone).toBe(2);
    expect(po.counts.czesciowe).toBe(0);
    expect(po.counts.niesprawdzone).toBe(1);

    const dryf = core.compareAcceptanceSummary(raport, po);
    expect(dryf.length, 'dryf tabeli statusów ma oblać').toBeGreaterThan(0);
    expect(dryf.some((p) => p.includes('status „częściowe”: raport mówi 1, a oceny dają 0')), `ma wskazać rozjazd częściowych 1≠0, a jest: ${dryf.join(' | ')}`).toBe(true);
    expect(dryf.some((p) => p.includes('status „niesprawdzone”: raport mówi 0, a oceny dają 1')), `ma wskazać rozjazd niesprawdzonych 0≠1, a jest: ${dryf.join(' | ')}`).toBe(true);
  });

  /* Klasyfikacja właściciela 2026-09-20: status „informacyjne” jest poza bramką
     odbioru — nie liczy się do otwartych (nie blokuje zamknięcia warstwy), ale
     nie może przemknąć bez uzasadnienia ani nie może trafić do backlogu. */
  it('2b. status „informacyjne” jest poza bramką: wymaga uzasadnienia, zakazuje backlogu, nie liczy się do otwartych', () => {
    const uzasadnione = wylicz(
      KANON,
      ocenyZ({
        'L1.1': {},
        'L1.2': { status: 'informacyjne', gap: 'proceduralne/niewywoływalne — klasyfikacja właściciela 2026-09-20' },
        'L2.1': {},
      }),
    );
    expect(uzasadnione.problems, 'informacyjne z uzasadnieniem i bez backlogu ma być spójne').toEqual([]);
    // Outside OPEN: the layer closes, and the criterion plans nothing.
    expect(uzasadnione.counts.informacyjne).toBe(1);
    expect(uzasadnione.perLayer.find((l) => l.num === 1)?.open).toEqual([]);
    expect(uzasadnione.closed.map((l) => l.num)).toContain(1);
    expect(uzasadnione.openCriteria).toBe(0);
    expect([...uzasadnione.backlog.keys()], 'informacyjne nie może trafić do pakietu').toEqual([]);

    // Without a justification it is a problem — the classification cannot be silent.
    const bezUzasadnienia = wylicz(
      KANON,
      ocenyZ({
        'L1.1': {},
        'L1.2': { status: 'informacyjne', gap: '—' },
        'L2.1': {},
      }),
    );
    expect(bezUzasadnienia.problems).toContain('L1.2: kryterium „informacyjne” bez uzasadnienia w opisie braku');

    // With a backlog package it is a problem too: poza bramką niczego nie planuje.
    const zBacklogiem = wylicz(
      KANON,
      ocenyZ({
        'L1.1': {},
        'L1.2': { status: 'informacyjne', gap: 'uzasadnienie', backlog: 'BL-01' },
        'L2.1': {},
      }),
    );
    expect(zBacklogiem.problems).toContain('L1.2: kryterium „informacyjne” nie może mieć pakietu backlogu (BL-01)');
  });

  it('3. duplikat identyfikatora oblewa w kanonie i w archiwum', () => {
    const duplikat = core.parseSpecification('# x\n\n### 1. Warstwa 1\n\n- [ ] **L1.1** a\n- [ ] **L1.1** b\n', { layers: 1, criteria: 2, scenarios: 0 });
    expect(duplikat.problems, 'drugi L1.1 stoi na pozycji L1.2').toContain('specyfikacja: L1.1 na pozycji L1.2');
    expect(duplikat.problems, 'powtórzony identyfikator ma być zgłoszony jako duplikat').toContain('specyfikacja: duplikat L1.1');

    const archiwum = core.parseArchiveSpecification('# x\n\n### 1. Warstwa 1\n\n- [ ] a\n- [ ] b\n\n### 1. Warstwa 1 ponownie\n\n- [ ] c\n', { layers: 1, criteria: 3 });
    expect(archiwum.problems, 'powtórzony numer warstwy daje te same ID pozycyjne → duplikat').toContain('specyfikacja archiwalna: duplikat L1.1');
  });

  it('4. rozjazd EXPECTED vs sparsowane oblewa (kanon 3≠200, archiwum 2≠95)', () => {
    const kanon = core.parseSpecification(KANON, core.EXPECTED);
    expect(kanon.problems, 'fixture 3-kryteriowy ma oblać kanon 200').toContain('specyfikacja: 3 kryteriów zamiast 200');
    expect(kanon.problems).toContain('specyfikacja: 2 warstw zamiast 12');
    expect(kanon.problems).toContain('specyfikacja: 0 prób zamiast 27');

    const archiwum = core.parseArchiveSpecification('# a\n\n### 1. Warstwa 1\n\n- [ ] a\n- [ ] b\n', core.EXPECTED_ARCHIVE);
    expect(archiwum.problems, 'fixture 2-kryteriowy ma oblać archiwum 95').toContain('specyfikacja archiwalna: 2 kryteriów zamiast 95');
    expect(archiwum.problems).toContain('specyfikacja archiwalna: 1 warstw zamiast 12');

    const kross = core.crossCheckArchive(
      ocenyZ({ 'L1.1': { historical: { status: 'potwierdzone' } }, 'L1.2': {} }),
      { criteria: archiwum.criteria },
      { layers: 1, criteria: 2 },
    );
    expect(kross, '1 pole historical przy stałej 2 ma oblać').toContain('oceny: 1 pól "historical" zamiast 2');
    expect(kross.some((p) => p.includes('L1.2 nie ma pola "historical"')), `brakujące pole archiwalne ma oblać, a jest: ${kross.join(' | ')}`).toBe(true);
    expect(core.crossCheckArchive(ocenyZ({ 'L1.1': { historical: { status: 'potwierdzone' } }, 'L1.2': { historical: { status: 'potwierdzone' } } }), { criteria: archiwum.criteria }, { layers: 1, criteria: 2 }), 'pełna krosówka na zgodnych fixture\'ach ma przechodzić').toEqual([]);
  });

  it('5. podręczny raport pochodny ze zmyślonymi liczbami nie przechodzi weryfikacji', () => {
    const ev = wylicz(KANON, { ...OCENY, backlog: OCENY_BACKLOG });
    const zmyslony = core.parseAcceptanceSummary(
      raportZ({ potwierdzone: 99, 'częściowe': 1 }, 100, [
        { num: 1, kryteria: 2, otwarte: 1, ids: 'L1.2' },
        { num: 2, kryteria: 98, otwarte: 0, ids: '' },
      ], 'L2'),
    );
    const problemy = core.compareAcceptanceSummary(zmyslony, ev);
    expect(problemy.length, 'zmyślony raport ma oblać').toBeGreaterThan(0);
    expect(problemy.some((p) => p.includes('raport mówi 100 kryteriów, a oceny i specyfikacja dają 3')), `ma wskazać 100≠3, a jest: ${problemy.join(' | ')}`).toBe(true);
    expect(problemy.some((p) => p.includes('raport mówi 99, a oceny dają 2')), `ma wskazać 99≠2, a jest: ${problemy.join(' | ')}`).toBe(true);

    expect(
      core.compareAcceptanceSummary(core.parseAcceptanceSummary('# bez sekcji podsumowania'), ev).length,
      'raport bez sekcji „Podsumowanie (wyliczone)” ma oblać',
    ).toBeGreaterThan(0);

    const backlog = core.parseBacklogSummary('# Backlog\n\nOtwartych kryteriów: **7** z 3, w 9 pakietach. Kolejność pakietów jest propozycją.\n');
    const problemyBacklog = core.compareBacklogSummary(backlog, ev);
    expect(problemyBacklog.some((p) => p.includes('raport mówi 7 otwartych kryteriów, a oceny dają 1')), `ma wskazać 7≠1, a jest: ${problemyBacklog.join(' | ')}`).toBe(true);
    expect(problemyBacklog.some((p) => p.includes('9 pakietów, a oceny dają 1')), `ma wskazać 9≠1 pakietów, a jest: ${problemyBacklog.join(' | ')}`).toBe(true);
  });
});

/* ------------------------ bramki na tym drzewie ---------------------------- */

describe('bramki macierzowe na repo (smoke, bez mutacji plików)', () => {
  const uruchom = (polecenie: string, argumenty: string[]) => {
    const r = spawnSync(polecenie, argumenty, { cwd: REPO, encoding: 'utf8' });
    if (r.error) throw new Error(`nie udało się uruchomić ${polecenie}: ${r.error.message}`);
    if (r.status !== 0) {
      throw new Error(
        `${polecenie} ${argumenty.join(' ')} zakończone kodem ${r.status} (oczekiwane 0)\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      );
    }
    return r;
  };

  it('check:acceptance — macierz 200 spójna, raporty bez dryfu', () => {
    const r = uruchom('node', [resolve(REPO, 'scripts/acceptance-matrix.mjs'), '--check']);
    expect(r.stdout).toContain('kryteria: 200');
    expect(r.stdout).toContain('spójność: OK');
  });

  it('check:matrix — kanon, krosówka 95↔200 i raporty pochodne zgodne', () => {
    const r = uruchom('node', [resolve(REPO, 'scripts/matrix-summary.mjs'), '--check']);
    expect(r.stdout).toContain('kanon: kryteria 200');
    expect(r.stdout).toContain('archiwum 95: 95 pól "historical"');
    expect(r.stdout).toContain('spójność: OK');
  });

  it('check:closure (tak jak w verify: --summary > /dev/null) — archiwum 95 spójne', () => {
    const r = uruchom('pnpm', ['run', 'check:closure']);
    expect(r.status).toBe(0);
  });
});
