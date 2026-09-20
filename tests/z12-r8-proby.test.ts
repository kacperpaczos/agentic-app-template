/**
 * Próby recenzenta rundy 8 (z12) — NIE jest to część regresji autora.
 *
 * 1. Równoważność TS (util/real-path.ts) ↔ skrypty (scripts/lib/state-tools.mjs)
 *    na KSZTAŁTACH WŁASNYCH, poza tymi z tests/isolation-paths.test.ts:
 *    `..` na samej górze, `..` między dwoma dowiązaniami, dowiązanie do
 *    dowiązania zerwanego, ścieżka bezwzględna przez katalog bazowy, puste
 *    komponenty, ENOTDIR, limit dowiązań.
 * 2. W1: tylda we wzorcu i w ścieżce (+ homoglify Unicode — co robi reguła).
 * 3. W7: dwa różne powody braku rozwiązania → ten sam napis; para z przeglądu
 *    rundy 6 (istniejący plik poza workspace vs nieistniejący człon).
 * 4. Kontrakt rzutu na własnych kształtach.
 *
 * Odcisk pliku poświadczeń (size:mtimeMs) porównywany po pliku — nic w tym
 * pliku nie wolno go dotknąć.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  realResolve,
  realResolveFrom,
  UnresolvablePathError,
} from '../packages/platform-server/src/util/real-path.ts';
import {
  directoryWalkRefusal,
  resolvedPathInput,
  workspaceConfinementRefusal,
} from '../packages/platform-server/src/agent/permissions.ts';
import { resolveInWorkspace } from '../packages/platform-server/src/agent/sandbox.ts';

/* ---------- odcisk pliku poświadczeń (G21) ---------- */
const POSEWIADCZENIE = join(process.env.HOME ?? '', '.claude', '.credentials.json');
const odcisk = (): string => {
  try {
    const s = statSync(POSEWIADCZENIE);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'brak';
  }
};
const odciskPrzed = odcisk();

/* ---------- katalogi prób ---------- */
const made: string[] = [];
const proba = (nazwa: string): string => {
  const d = mkdtempSync(join(tmpdir(), `z12-r8-${nazwa}-`));
  made.push(d);
  return d;
};
const stanowe = async (): Promise<{ realResolve: (p: string) => string }> =>
  (await import(resolve(import.meta.dirname, '../scripts/lib/state-tools.mjs'))) as {
    realResolve: (p: string) => string;
  };

afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (odcisk() !== odciskPrzed) {
    throw new Error('plik poswiadczen uzytkownika zmienil odcisk w trakcie prob');
  }
});

/* ---------- pomost równoważności ---------- */
type Wynik = { ok: string } | { blad: string };
/* Kontrakt rundy 7: bliźniak rzuca „tę samą klasę błędu pod inną nazwą"
 * (UnresolvablePathError / NierozwiazywalnaSciezka), więc równoważność
 * porównuję po TREŚCI komunikatu, a nazwy klas sprawdzam osobno (niżej). */
const probuj = (fn: (p: string) => string, p: string): Wynik => {
  try {
    return { ok: fn(p) };
  } catch (e) {
    return { blad: (e as Error).message };
  }
};
const nazwaBledu = (fn: () => string): string => {
  try {
    fn();
    return '(nie rzucil)';
  } catch (e) {
    return (e as Error).name;
  }
};
const oba = async (p: string): Promise<{ ts: Wynik; mjs: Wynik }> => {
  const scripts = await stanowe();
  return { ts: probuj(realResolve, p), mjs: probuj(scripts.realResolve, p) };
};
const oczekujZgodnosci = (wynik: { ts: Wynik; mjs: Wynik }): string => {
  expect(wynik.ts).toEqual(wynik.mjs);
  if ('ok' in wynik.ts) return wynik.ts.ok;
  return wynik.ts.blad;
};
/** Wymaga, że obie wersje RZUCIŁY, i zwraca wspólną treść komunikatu. */
const oczekujRzut = (wynik: { ts: Wynik; mjs: Wynik }): string => {
  expect(wynik.ts).toEqual(wynik.mjs);
  if (!('blad' in wynik.ts)) throw new Error('mial rzucic w obu jezykach');
  return wynik.ts.blad;
};

describe('rownowaznosc TS <-> mjs na ksztaltach wlasnych recenzenta', () => {
  it('S1: ".." na samej gorze sciezki bezwzglednej i wzglednej', async () => {
    const base = proba('s1');
    const wynik = await oba(`${base}/../plik-poza.txt`);
    const wartosc = oczekujZgodnosci(wynik);
    expect(wartosc).toBe(join(dirname(realResolve(base)), 'plik-poza.txt'));
    // korzeń: `..` z korzenia zostaje w korzeniu
    const uKorzenia = await oba('/../x.txt');
    expect(oczekujZgodnosci(uKorzenia)).toBe('/x.txt');
    // względna — obie z tego samego cwd; wystarczy identyczność
    const wzgledna = await oba('../z12-r8-s1-wzgledna');
    oczekujZgodnosci(wzgledna);
  });

  it('S2: ".." miedzy dwoma dowiazaniami ( cele bezwzgledne i wzgledne )', async () => {
    const base = proba('s2');
    const pozaA = proba('s2-poza-a');
    const pozaB = join(proba('s2-poza-b'), 'glebiej');
    mkdirSync(pozaB, { recursive: true });
    symlinkSync(pozaA, join(base, 'l1'), 'dir');
    symlinkSync(pozaB, join(pozaA, 'l2'), 'dir');
    const wynik = await oba(`${base}/l1/l2/../x.txt`);
    const wartosc = oczekujZgodnosci(wynik);
    // jądro: l1 → pozaA, l2 → pozaB, `..` cofa od RODZICA pozaB, więc <tmp pozaB>/x.txt
    expect(wartosc).toBe(join(dirname(realResolve(pozaB)), 'x.txt'));
    // łańcuch z celem względnym na końcu
    symlinkSync('r2', join(base, 'r1'), 'dir');
    symlinkSync(pozaB, join(base, 'r2'), 'dir');
    const wzgledny = await oba(`${base}/r1/../x.txt`);
    const wartosc2 = oczekujZgodnosci(wzgledny);
    expect(wartosc2).toBe(join(dirname(realResolve(pozaB)), 'x.txt'));
  });

  it('S3: dowiazanie do dowiazania zerwanego', async () => {
    const base = proba('s3');
    const poza = proba('s3-poza');
    symlinkSync('b', join(base, 'a'), 'dir');
    symlinkSync('nie-ma-konca', join(base, 'b'), 'dir');
    /* `..` po łańcuchu urywanym w nieistniejącym celu: oba rzucają, ten sam napis */
    const zGora = await oba(`${base}/a/../x.txt`);
    expect(oczekujRzut(zGora)).toContain('".." po komponencie');
    /* bez `..`: oba wskazują to samo nieistniejące miejsce za zerwanym celem */
    const bezGora = await oba(`${base}/a/y.txt`);
    expect(oczekujZgodnosci(bezGora)).toBe(join(realResolve(base), 'nie-ma-konca', 'y.txt'));
    /* zerwane dowiązanie o celu BEZWZGLĘDNYM */
    symlinkSync(join(poza, 'brak'), join(base, 'c'), 'dir');
    const absZerwane = await oba(`${base}/c/../y.txt`);
    expect(oczekujRzut(absZerwane)).toContain('".." po komponencie');
  });

  it('S4: sciezka bezwzgledna przez katalog bazowy, takze z ".." po nieistniejacym', async () => {
    const base = proba('s4');
    const poza = proba('s4-poza');
    writeFileSync(join(poza, 'plik.txt'), 'kanarek');
    symlinkSync(poza, join(base, 'link'), 'dir');
    const przez = await oba(`${base}/link/plik.txt`);
    expect(oczekujZgodnosci(przez)).toBe(join(realResolve(poza), 'plik.txt'));
    const wyjscie = await oba(`${base}/nie-ma/../link/plik.txt`);
    expect(oczekujRzut(wyjscie)).toContain('".." po komponencie');
  });

  it('S5: puste komponenty, kropki, napis pusty i kropka', async () => {
    const base = proba('s5');
    mkdirSync(join(base, 'wewnatrz'), { recursive: true });
    expect(oczekujZgodnosci(await oba(`${base}//wewnatrz///x.txt`))).toBe(
      join(realResolve(base), 'wewnatrz', 'x.txt'),
    );
    expect(oczekujZgodnosci(await oba(`${base}/wewnatrz/`))).toBe(realResolve(`${base}/wewnatrz`));
    expect(oczekujZgodnosci(await oba(`${base}/./wewnatrz/.`))).toBe(realResolve(`${base}/wewnatrz`));
    /* napis pusty i sama kropka: obie wersje zwracają bazę (cwd) */
    const pusty = await oba('');
    expect(pusty.ts).toEqual(pusty.mjs);
    const kropka = await oba('.');
    expect(kropka.ts).toEqual(kropka.mjs);
  });

  it('S6: ENOTDIR i limit dowiazan — obie wersje ten sam powod', async () => {
    const base = proba('s6');
    writeFileSync(join(base, 'plik.txt'), 'zwykly');
    const enotdir = await oba(`${base}/plik.txt/sub`);
    expect(oczekujRzut(enotdir)).toContain('nie jest katalogiem');
    /* łańcuch 41 dowiązań — oba rzucają limit */
    symlinkSync('koniec', join(base, 'k41'), 'dir');
    for (let i = 40; i >= 2; i -= 1) symlinkSync(`k${i + 1}`, join(base, `k${i}`), 'dir');
    symlinkSync('k2', join(base, 'k1'), 'dir');
    mkdirSync(join(base, 'koniec'), { recursive: true });
    const limit = await oba(`${base}/k1/x.txt`);
    expect(oczekujRzut(limit)).toContain('przekroczono limit dowiazan');
  });

  it('S7: realResolveFrom(base, ...) i mjs na tym samym kandydacie bezwzględnym', async () => {
    const base = proba('s7');
    mkdirSync(join(base, 'wewnatrz'), { recursive: true });
    const scripts = await stanowe();
    const kandydat = `${base}/wewnatrz`;
    expect(probuj((p) => realResolveFrom(base, p), kandydat)).toEqual(
      probuj(scripts.realResolve, kandydat),
    );
  });

  it('S8: kontrakt nazw klas — TS "UnresolvablePathError", mjs "NierozwiazywalnaSciezka", ta sama treść', async () => {
    const base = proba('s8');
    const scripts = await stanowe();
    const proba_ = `${base}/nie-ma/../x`;
    expect(nazwaBledu(() => realResolve(proba_))).toBe('UnresolvablePathError');
    expect(nazwaBledu(() => scripts.realResolve(proba_))).toBe('NierozwiazywalnaSciezka');
    expect(probuj(realResolve, proba_)).toEqual(probuj(scripts.realResolve, proba_));
  });
});

/* ---------- W1: tylda we wzorcu i w path ---------- */
describe('W1 — tylda we wzorcu Glob/Grep i w path', () => {
  let ws: string;
  let poza: string;
  const odpal = (input: Record<string, unknown>): string | null =>
    workspaceConfinementRefusal('Glob', input, ws);

  const ustaw = () => {
    ws = proba('w1-ws');
    mkdirSync(join(ws, 'output'), { recursive: true });
    poza = proba('w1-poza');
  };

  it('wzorzec z tyldą na początku jest odmawiany, zwykły przechodzi', () => {
    ustaw();
    expect(odpal({ path: join(ws, 'output'), pattern: '~/.claude/*' })).toContain('tyld');
    expect(odpal({ path: join(ws, 'output'), pattern: '~' })).toContain('tyld');
    expect(odpal({ path: join(ws, 'output'), pattern: 'a/~b/c' })).toContain('tyld');
    expect(odpal({ path: join(ws, 'output'), pattern: '**/*.txt' })).toBeNull();
  });

  it('tylda w argumentcie path jest odmawiana (kontrola rundy 6)', () => {
    ustaw();
    expect(odpal({ path: '~/x', pattern: '**' })).toContain('tyld');
    expect(odpal({ path: join(ws, 'output/~uzytkownik'), pattern: '**' })).toContain('tyld');
  });

  it('homoglify tyldy (U+223C, U+FF5E, U+02DC): reguła je PRZEPUSZCZA — zapis zachowania', () => {
    ustaw();
    const homoglify = ['∼/.claude/*', '～/.claude/*', '˜x'];
    for (const wzor of homoglify) {
      const wynik = odpal({ path: join(ws, 'output'), pattern: wzor });
      /* Zapis zachowania, nie postulatu: nic w tym stosie nie rozwija
       * homoglifów, więc kształt „sprawdzono A, otwarto B" nie powstaje —
       * wzorzec jest literalny tak dla strażnika, jak i dla globu. */
      expect(wynik, `homoglif ${wzor}`).toBeNull();
    }
  });
});

/* ---------- W7: jednolite odmowy, zero wyroczni ---------- */
describe('W7 — odmowy nierozwiązywalnych ścieżek', () => {
  let ws: string;
  const read = (sciezka: string): string | null =>
    workspaceConfinementRefusal('Read', { file_path: sciezka }, ws);

  const ustaw = () => {
    ws = proba('w7-ws');
    mkdirSync(join(ws, 'output'), { recursive: true });
    writeFileSync(join(ws, 'plik-txt'), 'zwykly plik');
    const poza = proba('w7-poza');
    writeFileSync(join(poza, 'passwd'), 'plik poza workspace');
    symlinkSync(poza, join(ws, 'etclink'), 'dir');
  };

  it('dwa różne powody braku rozwiązania → TEN SAM napis odmowy', () => {
    ustaw();
    const a = read('nie-ma/../x.txt'); // `..` po nieistniejącym
    const b = read('plik-txt/x.txt'); // ENOTDIR: plik w miejscu katalogu
    if (!a || !b) throw new Error('odmowa miala byc');
    expect(a).toBe(b);
    expect(a).toContain('nie da sie jednoznacznie');
    expect(a.includes('nie istnieje')).toBe(false);
    expect(a.includes('nie jest katalogiem')).toBe(false);
  });

  it('para z przeglądu rundy 6: etclink/passwd/x vs etclink/nie-ma/x', () => {
    ustaw();
    const istniejacyPlik = read('etclink/passwd/x');
    const nieistniejacy = read('etclink/nie-ma/x');
    if (!istniejacyPlik || !nieistniejacy) throw new Error('odmowa miala byc');
    /* Nazwy komponentów nie wracają w żadnej z odmów. */
    expect(istniejacyPlik.includes('passwd')).toBe(false);
    expect(istniejacyPlik.includes('nie jest katalogiem')).toBe(false);
    /* Zapis faktu: obie odmowy powstają w DWÓCH różnych klasach reguły
     * (nierozwiązywalna vs poza workspace), więc napisy się różnią — patrz raport. */
    void nieistniejacy;
  });

  it('directoryWalkRefusal: dwa powody → ten sam napis', () => {
    ustaw();
    const a = directoryWalkRefusal('Glob', { path: 'nie-ma/../x' }, ws);
    const b = directoryWalkRefusal('Glob', { path: 'plik-txt/x' }, ws);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('resolveInWorkspace: sandbox_denied, bez powodu istnienia w details', () => {
    ustaw();
    try {
      resolveInWorkspace(ws, 'nie-ma/../x.txt');
      expect.unreachable('mial rzucic sandbox_denied');
    } catch (err) {
      expect((err as Error).name).toBe('AppError');
      expect((err as Error).message).toMatch(/sandbox_denied|Sciezka wychodzi/);
      const zapis = JSON.stringify((err as { details?: unknown }).details ?? {});
      expect(zapis.includes('reason')).toBe(false);
      expect(zapis.includes('nie istnieje')).toBe(false);
      expect(zapis.includes('nie jest katalogiem')).toBe(false);
    }
    /* ta sama wiadomość dla kształtu zwykle poza workspace */
    try {
      resolveInWorkspace(ws, '../nie-ma-poza');
      expect.unreachable('mial rzucic sandbox_denied');
    } catch (err) {
      expect((err as Error).message).toBe('Sciezka wychodzi poza workspace uruchomienia.');
    }
  });

  it('resolvedPathInput przy rzucie zwraca null', () => {
    ustaw();
    expect(
      resolvedPathInput('Read', { file_path: 'nie-ma/../x' }, () => {
        throw new UnresolvablePathError('nie-ma/../x', '".." po komponencie, ktory nie istnieje');
      }),
    ).toBeNull();
  });
});
