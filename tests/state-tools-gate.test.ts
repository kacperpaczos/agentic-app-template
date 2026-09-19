import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Every wrapper in the state scripts' gate must operate on the path the gate
 * returned — never on the argument as it arrived.
 *
 * **The defect.** Each guarded operation in `scripts/lib/state-tools.mjs`
 * (`usun`, `utworzKatalog`, `zapisz`, `kopiujPlik`, `kopiujDrzewo`, `przenies`)
 * used to call `assertApproved(path, ...)` for its refusal and then hand the
 * **raw argument** to `node:fs`. The gate checked one path and the kernel
 * opened another. The gap was latent rather than active, because `realResolve`
 * happens to answer what the kernel answers on a filesystem nothing else is
 * moving — but that made the safety of every state script rest on `realResolve`
 * staying a faithful copy of the kernel *forever*. The same shape — check one
 * string, act on another — was exploited in the agent-tool guard of this
 * program after three reviewers had read the code and called it correct; there
 * it was fixed by handing the tool the already-checked path, so "checked" and
 * "opened" are the same string. This file is that fix, verified.
 *
 * **What the wrapper list is derived from.** The source itself: every
 * top-level declaration between `assertApproved` and the `sqlite` section
 * banner of `state-tools.mjs`. A hand-written list ages at the first wrapper
 * someone adds without updating it; a list read out of the region does not.
 * The region markers are asserted to exist, so the derivation fails loudly
 * rather than silently shrinking to nothing — a test that enumerates zero
 * wrappers proves nothing.
 *
 * **How each wrapper is judged.** Behaviour, not shape. `node:fs` is mocked
 * with a pass-through that records every call of the six mutating functions
 * (the same seam as `tests/publication.test.ts`; a namespace-property swap
 * cannot touch ESM named imports — see the header of
 * `tests/setup-credential-guard.ts`). Each wrapper is invoked with a path
 * that is **textually different** from its resolution — through a symlinked
 * parent plus a redundant `./` segment — and the recorded argument must equal
 * `realResolve(input)`: the value the gate checked and (since the fix) passed
 * on. On the old code the recorded argument is the raw input, and the test
 * fails.
 *
 * **Deliberately outside this file's claim:**
 *  - `kopiujPlik`/`kopiujDrzewo` receive `from` unguarded, on purpose: a
 *    source is read, and reads from a live data directory (backup) and from a
 *    user's backup (restore, rehearsal) are the whole point of these scripts.
 *    `assertApproved` decides "may I write here", not "may I read". The test
 *    pins the raw `from` as documented behaviour — if someone later guards it,
 *    the test sends them here to decide it again, not to change it silently.
 *  - The claim about raw calls is **whole-file**, not region-bound: every raw
 *    call of the six mutating functions anywhere in `state-tools.mjs` must sit
 *    in a gate wrapper or on `WYJATKI_SUROWYCH`, with a reason. That list has
 *    one entry, `removeSideFilesWeCreated`, whose justification (and its
 *    stated limit) lives with the definition.
 *  - That `realResolve` itself matches the kernel is *not* this file's claim —
 *    `tests/isolation-paths.test.ts` (`realResolve — jedna implementacja,
 *    dwa jezyki`) pins the scripts' `realResolve` to the platform's. After
 *    this fix the gate does not need that agreement to stay safe; the
 *    agreement is still tested, because other comparisons still rely on it.
 */

const bramka = vi.hoisted(() => ({
  /** Every call of a mutating fs function the wrappers make, in order. */
  fsLog: [] as Array<{ fn: string; args: unknown[] }>,
  /** The mutating `node:fs` functions. */
  MUTUJACE: ['rmSync', 'mkdirSync', 'writeFileSync', 'copyFileSync', 'cpSync', 'renameSync'] as const,
  /** Which argument positions of those functions are destinations. */
  POZYCJA_CELU: {
    rmSync: [0],
    mkdirSync: [0],
    writeFileSync: [0],
    copyFileSync: [1],
    cpSync: [1],
    renameSync: [0, 1],
  } as Record<string, number[]>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const nakladka: Record<string, unknown> = { ...actual };
  for (const fn of bramka.MUTUJACE) {
    const original = actual[fn] as (...a: unknown[]) => unknown;
    nakladka[fn] = (...a: unknown[]) => {
      bramka.fsLog.push({ fn, args: a });
      return original(...a);
    };
  }
  return { ...nakladka, default: nakladka } as unknown as typeof actual;
});

const REPO = resolve(import.meta.dirname, '..');
const LIB = resolve(REPO, 'scripts/lib/state-tools.mjs');
const ROOT = resolve(REPO, '.e2e-bl07');

/**
 * The wrapper names, read out of the guarded region of the source.
 *
 * The region runs from `assertApproved` (the gate itself, excluded by name)
 * to the `sqlite` section banner. Both markers are asserted, so a rename or
 * a moved banner breaks the test instead of emptying it.
 */
function wyliczOpakowania(): string[] {
  const src = readFileSync(LIB, 'utf8');
  const start = src.indexOf('function assertApproved(');
  expect(start, 'state-tools.mjs: nie znaleziono assertApproved — region bramki przesunal sie').toBeGreaterThanOrEqual(0);
  const banner = /\/\* -+ sqlite -+ \*\//.exec(src)?.index ?? -1;
  expect(banner, 'state-tools.mjs: nie znaleziono banera sekcji sqlite — koniec regionu bramki przesunal sie').toBeGreaterThan(start);
  const wycinek = src.slice(start, banner);
  const nazwy = [...wycinek.matchAll(/^(?:export )?(?:async )?(?:const|function) (\w+)/gm)]
    .map((m) => m[1]!)
    .filter((n) => n !== 'assertApproved');
  expect(nazwy.length, 'region bramki wyliczyl zero opakowan — sprawdzanie nic nie widzi').toBeGreaterThan(0);
  return nazwy;
}

/**
 * Raw mutating calls that live outside the gate wrappers, each with its reason.
 *
 * Adding an entry here is a decision, not a shortcut: the enclosing function
 * must be named, and the reason must be stated. The one entry is
 * `removeSideFilesWeCreated`, whose justification (and its stated limit) lives
 * with the definition; the review of this package re-verified it against the
 * fixed gate — the exception rests on a difference of *existence* (`before`),
 * not on the gate or on `realResolve`, so the fix changes it neither way.
 * `tidy` needs no entry: it deletes through `usun`, the guarded wrapper.
 */
const WYJATKI_SUROWYCH: Record<string, string> = {
  removeSideFilesWeCreated:
    'usuwa wylacznie pliki boczne SQLite, ktorych nie bylo, gdy proces przyszedl — ' +
    'skasowanie ich nie moze stracic cudzych danych; pelne uzasadnienie przy definicji funkcji',
};

interface Lib {
  approveTarget: (p: string, o?: object) => string;
  realResolve: (p: string) => string;
  usun: (p: string, o?: object) => void;
  utworzKatalog: (p: string, o?: object) => void;
  zapisz: (p: string, data: string) => void;
  kopiujPlik: (from: string, to: string) => void;
  kopiujDrzewo: (from: string, to: string, o?: object) => void;
  przenies: (from: string, to: string) => void;
}

/** What the harness judges for one wrapper invocation. */
interface Oczekiwania {
  /** Recorded fs function. */
  fn: string;
  /** Argument position to judge. */
  argIndex: number;
  /** Path as handed to the wrapper. */
  wejsciowa: string;
  /** Expect the argument verbatim (a deliberately unguarded read), not resolved. */
  surowe?: boolean;
}

describe('bramka skryptow stanu operuje na sciezce, ktora sprawdzila', () => {
  let lib: Lib;
  let praca: string;
  let zatwierdzone: string;
  /** A symlink to the approved directory — the textual divergence in every input path. */
  let lacznik: string;

  const pk = (name: string) => `${lacznik}/./${name}`;

  beforeAll(async () => {
    lib = (await import(LIB)) as unknown as Lib;
    mkdirSync(ROOT, { recursive: true });
    praca = mkdtempSync(join(ROOT, 'bramka-'));

    zatwierdzone = resolve(praca, 'zatwierdzone');
    mkdirSync(resolve(zatwierdzone, 'drzewo-zrodlowe'), { recursive: true });
    writeFileSync(resolve(zatwierdzone, 'istniejacy.txt'), 'tresc\n');
    writeFileSync(resolve(zatwierdzone, 'zrodlowy.txt'), 'tresc\n');
    writeFileSync(resolve(zatwierdzone, 'przenoszony.txt'), 'tresc\n');
    writeFileSync(resolve(zatwierdzone, 'drzewo-zrodlowe', 'plik.txt'), 'tresc\n');
    lacznik = resolve(praca, 'lacznik');
    symlinkSync(zatwierdzone, lacznik);

    lib.approveTarget(zatwierdzone, { what: 'Katalog bramki' });
  });

  afterAll(() => {
    if (praca) rmSync(praca, { recursive: true, force: true });
  });

  /**
   * How to invoke each wrapper, and which arguments to judge.
   *
   * Hand-written, and *required* — the same rule as `PRZEPISY` in
   * `tests/script-path-flags.test.ts`: a wrapper with no scenario fails the
   * test, so a new wrapper cannot join the region without someone deciding how
   * it is exercised.
   */
  const SCENARIUSZE: Record<string, () => Oczekiwania[]> = {
    usun: () => {
      const cel = pk('istniejacy.txt');
      lib.usun(cel, { force: true });
      return [{ fn: 'rmSync', argIndex: 0, wejsciowa: cel }];
    },
    utworzKatalog: () => {
      const cel = pk('nowy-katalog');
      lib.utworzKatalog(cel, { recursive: true });
      return [{ fn: 'mkdirSync', argIndex: 0, wejsciowa: cel }];
    },
    zapisz: () => {
      const cel = pk('zapisany.txt');
      lib.zapisz(cel, 'tresc\n');
      return [{ fn: 'writeFileSync', argIndex: 0, wejsciowa: cel }];
    },
    kopiujPlik: () => {
      const zrodlo = resolve(zatwierdzone, 'zrodlowy.txt');
      const cel = pk('skopiowany.txt');
      lib.kopiujPlik(zrodlo, cel);
      return [
        { fn: 'copyFileSync', argIndex: 1, wejsciowa: cel },
        // `from` is read, not written: deliberately the raw argument.
        { fn: 'copyFileSync', argIndex: 0, wejsciowa: zrodlo, surowe: true },
      ];
    },
    kopiujDrzewo: () => {
      const zrodlo = resolve(zatwierdzone, 'drzewo-zrodlowe');
      const cel = pk('drzewo-skopiowane');
      lib.kopiujDrzewo(zrodlo, cel, { recursive: true });
      return [
        { fn: 'cpSync', argIndex: 1, wejsciowa: cel },
        { fn: 'cpSync', argIndex: 0, wejsciowa: zrodlo, surowe: true },
      ];
    },
    przenies: () => {
      const skad = pk('przenoszony.txt');
      const dokad = pk('przeniesiony-dokad.txt');
      lib.przenies(skad, dokad);
      return [
        { fn: 'renameSync', argIndex: 0, wejsciowa: skad },
        { fn: 'renameSync', argIndex: 1, wejsciowa: dokad },
      ];
    },
  };

  it('wylicza z zrodla dokladnie opakowania bramki', () => {
    // Scope, stated like `SCRIPTS` in script-path-flags: a seventh wrapper must
    // be added here AND given a scenario — two decisions, not zero.
    expect(wyliczOpakowania()).toEqual([
      'usun',
      'utworzKatalog',
      'zapisz',
      'kopiujPlik',
      'kopiujDrzewo',
      'przenies',
    ]);
  });

  it('zadne surowe wywolanie mutujace w calej bibliotece nie stoi poza opakowaniem bramki ani wyjatkiem', () => {
    /*
     * The claim "the mutating fs calls of these scripts live in one module, at
     * the gate" is whole-file, so this check is whole-file too — the wrapper
     * region above would otherwise be the enforcement's edge, and a raw
     * `rmSync` added next to `census` or above `assertApproved` would sit
     * outside every test while the comment still said "one place".
     *
     * Every raw call of the six mutating functions is attributed to its
     * enclosing top-level declaration. Only two kinds of enclosure are legal:
     * a gate wrapper (already behaviourally verified against the mocked fs by
     * the scenarios below — the same derivation names them) or a function on
     * `WYJATKI_SUROWYCH`, with its reason. Anything else fails, naming the
     * line and both ways out.
     */
    const src = readFileSync(LIB, 'utf8');

    const deklaracje = [...src.matchAll(/^(?:export )?(?:async )?(?:const|function) (\w+)/gm)]
      .map((m) => ({ nazwa: m[1]!, start: m.index! }));
    expect(deklaracje.length, 'state-tools.mjs: wyliczanie deklaracji gornorzednych nic nie widzi').toBeGreaterThan(0);

    const linie = src.split('\n');
    const nrLinii = (idx: number) => src.slice(0, idx).split('\n').length - 1;

    const surowe: Array<{ fn: string; idx: number; linia: number }> = [];
    for (const fn of bramka.MUTUJACE) {
      const wzor = new RegExp(`(^|[^.\\w])${fn}\\s*\\(`, 'g');
      for (const m of src.matchAll(wzor)) {
        const idx = m.index! + m[1]!.length;
        const tekst = linie[nrLinii(idx)] ?? '';
        // Mentions in prose are not calls; the same filter as script-path-flags.
        if (/^\s*\*/.test(tekst) || /^\s*\/\//.test(tekst)) continue;
        surowe.push({ fn, idx, linia: nrLinii(idx) + 1 });
      }
    }
    expect(
      surowe.length,
      'skan surowych wywolan znalazl zero trafien w calym pliku — regulka nic nie widzi',
    ).toBeGreaterThan(0);

    const opakowania = new Set(wyliczOpakowania());
    const oblewania: string[] = [];
    const pokryteWyjatki = new Set<string>();
    for (const t of surowe) {
      let otoczka: string | null = null;
      for (const d of deklaracje) {
        if (d.start < t.idx) otoczka = d.nazwa;
        else break;
      }
      if (otoczka && opakowania.has(otoczka)) continue;
      if (otoczka && WYJATKI_SUROWYCH[otoczka]) {
        pokryteWyjatki.add(otoczka);
        continue;
      }
      oblewania.push(
        otoczka
          ? `state-tools.mjs:${t.linia} — surowe ${t.fn} w ${otoczka}: przepusc przez opakowanie bramki ` +
              `(usun, utworzKatalog, zapisz, kopiujPlik, kopiujDrzewo, przenies) albo dopisz ${otoczka} ` +
              'do WYJATKOW_SUROWYCH w tests/state-tools-gate.test.ts, z powodem'
          : `state-tools.mjs:${t.linia} — surowe ${t.fn} na poziomie modulu: przepusc przez opakowanie bramki`,
      );
    }
    expect(
      oblewania,
      `surowe wywolania mutujace poza bramka i poza wyjatkami:\n${oblewania.join('\n')}`,
    ).toEqual([]);

    /*
     * The exception list stays honest in the other direction too: an entry
     * whose function no longer holds a raw call is a stale permission and is
     * removed here rather than kept for the next one to lean on.
     */
    const nietknete = Object.keys(WYJATKI_SUROWYCH).filter((n) => !pokryteWyjatki.has(n));
    expect(
      nietknete,
      'wyjatki surowych wywolan bez pokrycia w kodzie — usun wpis albo przywroc uzasadnienie',
    ).toEqual([]);
  });

  it.each(['usun', 'utworzKatalog', 'zapisz', 'kopiujPlik', 'kopiujDrzewo', 'przenies'])(
    '%s: jadro dostaje sciezke zwrocona przez bramke',
    (nazwa) => {
      const scenariusz = SCENARIUSZE[nazwa];
      expect(
        scenariusz,
        `${nazwa}: brak scenariusza — dopisz go i rozstrzygnij, ktory argument jest celem`,
      ).toBeDefined();

      bramka.fsLog.length = 0;
      const oczekiwania = scenariusz!();
      const rozstrzygniete = oczekiwania.map((o) => ({ ...o, rozwiazana: lib.realResolve(o.wejsciowa) }));

      /*
       * The inputs must actually diverge from their resolutions, or the whole
       * check is blind: a wrapper that passed the raw argument through would
       * then record exactly the expected string.
       */
      for (const o of rozstrzygniete) {
        if (!o.surowe) {
          expect(
            o.wejsciowa,
            `${nazwa}: sciezka wejsciowa (${o.wejsciowa}) jest tekstowo rowna rozwiazanej — scenariusz nic nie widzi`,
          ).not.toBe(o.rozwiazana);
        }
      }

      /*
       * No mutating function beyond the scenario's may fire: a wrapper that
       * reached for a second raw fs call would show up here.
       */
      const funkcje = new Set(rozstrzygniete.map((o) => o.fn));
      for (const r of bramka.fsLog) {
        expect(funkcje.has(r.fn), `${nazwa}: zapisalo wywolanie ${r.fn} poza scenariuszem`).toBe(true);
      }

      for (const o of rozstrzygniete) {
        const trafienia = bramka.fsLog.filter((r) => r.fn === o.fn);
        expect(
          trafienia.length,
          `${nazwa}: jadro nie zapisalo wywolania ${o.fn} — podmiana node:fs nie dosiega tego opakowania`,
        ).toBeGreaterThan(0);
        const dostarczona = trafienia.map((r) => String(r.args[o.argIndex]));
        if (o.surowe) {
          expect(
            dostarczona,
            `${nazwa}: argument ${o.argIndex} ${o.fn} mial byc surowym parametrem (odczyt, celowo niesprawdzany) — ` +
              'jesli to zmiana zamierzona, zaktualizuj scenariusz i uzasadnij ja tutaj',
          ).toContain(o.wejsciowa);
        } else {
          expect(
            dostarczona,
            `${nazwa}: jadro otworzylo ${dostarczona.join(', ')}, a bramka sprawdzila ${o.rozwiazana}`,
          ).toContain(o.rozwiazana);
        }
      }

      /*
       * Every destination position of every recorded call is accounted for,
       * even where the per-expectation list forgot one. This is what bites a
       * wrapper that calls the gate and then discards its value: the kernel
       * records the raw argument, which is in no expected set.
       */
      for (const r of bramka.fsLog) {
        for (const d of bramka.POZYCJA_CELU[r.fn] ?? []) {
          const arg = r.args[d];
          if (arg === undefined) continue;
          const dopuszczalne = rozstrzygniete
            .filter((o) => o.fn === r.fn && (!o.surowe || String(arg) === o.wejsciowa))
            .map((o) => (o.surowe ? o.wejsciowa : o.rozwiazana));
          expect(
            dopuszczalne,
            `${nazwa}: ${r.fn} dostalo na pozycji celu (${d}) wartosc ${String(arg)}, ktorej nic nie sprawdzilo`,
          ).toContain(String(arg));
        }
      }
    },
  );
});
