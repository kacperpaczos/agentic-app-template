import { chmodSync, existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Proby recenzenta (przeglad/z2-bramka, snapshot 420e94f) — nie jest to czesc
 * regresji szablonu; plik zyje na galezi przegladowej.
 *
 * Cztery pytania, kazda odpowiedz na prawdziwym dysku, wylacznie w katalogach
 * mkdtemp w /tmp (zaden katalog repo ani domowy nie jest tu dotykany):
 *
 *  1. Szew `vi.mock('node:fs')` z tests/state-tools-gate.test.ts naprawdę
 *     przepuszcza operacje do jadra: po `zapisz` plik istnieje na dysku
 *     (sprawdzane przez niepodmieniane `node:fs/promises`), czyli rejestr
 *     pokazuje rzeczywiste wywolanie, nie wlasny mock.
 *  2. Ksztalt „`..` za dowiazaniem" (wykorzystany w sasiednim pakiecie):
 *     bramka + naprawa musza zagwarantowac, ze jadro dostaje dokladnie
 *     `realResolve(wejscie)` takze wtedy, gdy `..` stoi za dowiazaniem.
 *  3. Wyjscie z regionu zatwierdzonego przez `..` za dowiazaniem albo przez
 *     dowiazanie absolutne na zewnatrz — musi skonczyc sie ODMAWA u wrót
 *     (zadne wywolanie mutujace nie pojawia sie w rejestrze, ofiara zyje).
 *  4. Decyzja o `from` (`kopiujPlik`/`kopiujDrzewo` czyta, nie pisze):
 *     zrodllo tylko-do-odczytu (katalog 0555, plik 0444) kopiuje sie bez bledu
 *     i bez zmiany odcisku zrodla — czyli `from` nie jest zapisywane.
 */

const rejestr = vi.hoisted(() => ({
  fsLog: [] as Array<{ fn: string; args: unknown[] }>,
  MUTUJACE: ['rmSync', 'mkdirSync', 'writeFileSync', 'copyFileSync', 'cpSync', 'renameSync'] as const,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const nakladka: Record<string, unknown> = { ...actual };
  for (const fn of rejestr.MUTUJACE) {
    const original = actual[fn] as (...a: unknown[]) => unknown;
    nakladka[fn] = (...a: unknown[]) => {
      rejestr.fsLog.push({ fn, args: a });
      return original(...a);
    };
  }
  return { ...nakladka, default: nakladka } as unknown as typeof actual;
});

const REPO = resolve(import.meta.dirname, '..');
const LIB = resolve(REPO, 'scripts/lib/state-tools.mjs');

interface Lib {
  approveTarget: (p: string, o?: object) => string;
  realResolve: (p: string) => string;
  usun: (p: string, o?: object) => void;
  zapisz: (p: string, data: string) => void;
  kopiujPlik: (from: string, to: string) => void;
  kopiujDrzewo: (from: string, to: string, o?: object) => void;
  przenies: (from: string, to: string) => void;
}

let lib: Lib;
let praca: string;
let zatwierdzone: string;
let pozaKatalog: string;

afterAll(() => {
  // Zanim cokolwiek skasujemy, przywracamy prawa do zrodel tylko-do-odczytu.
  try {
    if (zatwierdzone) {
      chmodSync(resolve(zatwierdzone, 'drzewo-ro'), 0o755);
      chmodSync(resolve(zatwierdzone, 'drzewo-ro', 'plik.txt'), 0o644);
      chmodSync(resolve(zatwierdzone, 'plik-ro.txt'), 0o644);
    }
    if (praca) rmSync(praca, { recursive: true, force: true });
    if (pozaKatalog) rmSync(pozaKatalog, { recursive: true, force: true });
  } catch {
    /* porzadki nie moga zabilic wyniku prob */
  }
});

describe('rev-z2: bramka na sprawdzanej sciezce — proby recenzenta', () => {
  beforeAll(async () => {
    lib = (await import(LIB)) as unknown as Lib;
    praca = mkdtempSync(join(tmpdir(), 'rev-z2-bramka-'));
    pozaKatalog = mkdtempSync(join(tmpdir(), 'rev-z2-poza-'));

    zatwierdzone = resolve(praca, 'zatwierdzone');
    mkdirSync(resolve(zatwierdzone, 'pod'), { recursive: true });
    mkdirSync(resolve(zatwierdzone, 'drzewo-ro'), { recursive: true });
    writeFileSync(resolve(zatwierdzone, 'pod', 'plik.txt'), 'pod\n');
    writeFileSync(resolve(zatwierdzone, 'istniejacy.txt'), 'tresc\n');
    writeFileSync(resolve(zatwierdzone, 'drzewo-ro', 'plik.txt'), 'cudza-tresc\n');
    writeFileSync(resolve(zatwierdzone, 'plik-ro.txt'), 'cudza-tresc\n');

    lib.approveTarget(zatwierdzone, { what: 'Katalog prob recenzenta' });
  });

  it('szew vi.mock przepuszcza do jadra: zapis istnieje na prawdziwym dysku', async () => {
    const cel = `${zatwierdzone}/pod/../przez-szew.txt`; // bez normalizacji — tekstowo rozbiezne
    const rozwiazana = lib.realResolve(cel);
    expect(cel).not.toBe(rozwiazana); // wejscie tekstowo rozbiezne z resolucja

    rejestr.fsLog.length = 0;
    lib.zapisz(cel, 'dowod-szewu\n');

    expect(rejestr.fsLog).toEqual([{ fn: 'writeFileSync', args: [rozwiazana, 'dowod-szewu\n'] }]);
    // Niepodmieniany modul (node:fs/promises nie jest objectem vi.mock) czyta dysk:
    const fsPromises = await import('node:fs/promises');
    await expect(fsPromises.readFile(rozwiazana, 'utf8')).resolves.toBe('dowod-szewu\n');
  });

  it('„..” za dowiazaniem (wlot do srodka): jadro dostaje dokladnie realResolve(wejscie)', () => {
    symlinkSync(resolve(zatwierdzone, 'pod'), resolve(zatwierdzone, 'lacznik'));
    // Jadrowo: lacznik -> zatwierdzone/pod, wiec lacznik/../istniejacy.txt
    // otwiera zatwierdzone/istniejacy.txt (WSRODZE). Tekstowo: praca/istniejacy.txt.
    const wejscie = `${resolve(zatwierdzone, 'lacznik')}/../istniejacy.txt`;
    const rozwiazana = lib.realResolve(wejscie);
    expect(rozwiazana).toBe(resolve(zatwierdzone, 'istniejacy.txt'));

    rejestr.fsLog.length = 0;
    lib.usun(wejscie, { force: true });

    const rm = rejestr.fsLog.filter((r) => r.fn === 'rmSync');
    expect(rm.length).toBe(1);
    expect(String(rm[0]!.args[0])).toBe(rozwiazana); // niezmiennik naprawy
    expect(existsSync(resolve(zatwierdzone, 'pod', 'plik.txt'))).toBe(true); // sasiad zyje
  });

  it('„..” za dowiazaniem (wylot na zewnatrz): ODMAWA u wrót, nic nie dotkniete', () => {
    symlinkSync(resolve(zatwierdzone, 'pod'), resolve(zatwierdzone, 'wylot'));
    const ofiara = resolve(praca, 'poza.txt');
    writeFileSync(ofiara, 'zywa-ofiara\n');
    // wylot/../../poza.txt jadrowo = praca/poza.txt — POZA zatwierdzonym.
    const wejscie = `${resolve(zatwierdzone, 'wylot')}/../../poza.txt`;
    expect(lib.realResolve(wejscie)).toBe(ofiara);

    rejestr.fsLog.length = 0;
    expect(() => lib.usun(wejscie, { force: true })).toThrow(/poza katalogami zatwierdzonymi/);
    expect(rejestr.fsLog).toEqual([]); // jadro w ogole nie zostalo wolane
    expect(readFileSync(ofiara, 'utf8')).toBe('zywa-ofiara\n');
  });

  it('dowiazanie absolutne na zewnatrz w srodku zatwierdzonego: ODMAWA, ofiara zyje', () => {
    const drzwi = resolve(zatwierdzone, 'drzwi');
    symlinkSync(pozaKatalog, drzwi);
    const ofiara = resolve(pozaKatalog, 'canary.txt');
    writeFileSync(ofiara, 'kanarek\n');

    rejestr.fsLog.length = 0;
    expect(() => lib.usun(resolve(drzwi, 'canary.txt'), { force: true })).toThrow(
      /poza katalogami zatwierdzonymi/,
    );
    expect(rejestr.fsLog).toEqual([]);
    expect(readFileSync(ofiara, 'utf8')).toBe('kanarek\n');
  });

  it('from tylko czyta: zrodlo 0555/0444 kopiuje sie bez bledu i bez zmian', () => {
    const odcisk = (p: string) => readFileSync(p, 'utf8');
    const plikRo = resolve(zatwierdzone, 'plik-ro.txt');
    const drzewoRo = resolve(zatwierdzone, 'drzewo-ro');
    chmodSync(plikRo, 0o444);
    chmodSync(drzewoRo, 0o555);
    chmodSync(resolve(drzewoRo, 'plik.txt'), 0o444);
    const przed = odcisk(resolve(drzewoRo, 'plik.txt'));

    rejestr.fsLog.length = 0;
    expect(() => lib.kopiujPlik(plikRo, resolve(zatwierdzone, './kopia-pliku.txt'))).not.toThrow();
    expect(() =>
      lib.kopiujDrzewo(drzewoRo, resolve(zatwierdzone, './kopia-drzewa'), { recursive: true }),
    ).not.toThrow();

    expect(odcisk(resolve(zatwierdzone, 'kopia-pliku.txt'))).toBe(przed);
    expect(odcisk(resolve(zatwierdzone, 'kopia-drzewa', 'plik.txt'))).toBe(przed);
    // Zrodlo nietkniete (zawartosc i obecnosc):
    expect(odcisk(resolve(drzewoRo, 'plik.txt'))).toBe(przed);
    expect(existsSync(resolve(drzewoRo, 'plik.txt'))).toBe(true);
  });

  it('przenies: strona niesprawdzona konczy sie ODMAWA, plik zostaje na miejscu', () => {
    const zrodlo = resolve(pozaKatalog, 'przenoszony.txt');
    writeFileSync(zrodlo, 'trwam\n');

    rejestr.fsLog.length = 0;
    expect(() => lib.przenies(zrodlo, resolve(zatwierdzone, './przeniesiony.txt'))).toThrow(
      /poza katalogami zatwierdzonymi/,
    );
    expect(rejestr.fsLog).toEqual([]); // renameSync nigdy nie pojdzie do jadra
    expect(readFileSync(zrodlo, 'utf8')).toBe('trwam\n');
  });

  it('kopiujDrzewo do wlasnego poddrzewa zrodla: jadro protestuje, zrodlo nietkniete', () => {
    const drzewoRo = resolve(zatwierdzone, 'drzewo-ro');
    const przed = readFileSync(resolve(drzewoRo, 'plik.txt'), 'utf8');
    rejestr.fsLog.length = 0;
    let kod: string | null = null;
    try {
      lib.kopiujDrzewo(drzewoRo, resolve(drzewoRo, 'kopia-w-srodku'), { recursive: true });
    } catch (e) {
      kod = (e as NodeJS.ErrnoException).code ?? String(e);
    }
    // Informacyjnie: cpSync odmawia kopiowania katalogu do wlasnego poddrzewa.
    // Zapis do `to` i tak przeszedlby przez bramke (drzewo-ro lezy w zatwierdzonym),
    // wiec tu nie ma ucieczki z bramki — sprawdzamy, ze zrodlo nie uleglo zmianie.
    // eslint-disable-next-line no-console
    console.log(`[rev-z2] cpSync do wlasnego poddrzewa: kod=${kod ?? 'BRAK-BLEDU'}`);
    expect(readFileSync(resolve(drzewoRo, 'plik.txt'), 'utf8')).toBe(przed);
    expect(existsSync(resolve(drzewoRo, 'kopia-w-srodku'))).toBe(false);
  });
});
