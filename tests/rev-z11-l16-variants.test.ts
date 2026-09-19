import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { descendants, stillRunning } from '../e2e/support/bl03-checks.ts';

/**
 * WARIANTY RECENZENTA (przeglad/z11-pt) dla przyrzadu L1.6 — pid + czas startu.
 *
 * Dwa przypadki, ktorych proba autora nie podstawia wprost:
 *  1. WYSCIG: potomek wychodzi, zanim tozsamosc zostanie chwycona — przyrzad
 *     nie moze klamnac ani w jedna strone (fantomowy wyciek), ani w druga
 *     (zgloszenie procesu, ktory nie istnieje, po jego wyjsciu).
 *  2. ADOPCJA: rodzic ginie (SIGKILL), potomek jest przepinany do innego
 *     rodzica — przyrzad ma nadal widziec TEN SAM proces (pid + czas startu),
 *     a nie odpowiedziec „nieobecny".
 */

const NA_LINUKSIE = existsSync('/proc');

/** Zyje dopoki go nie zabijemy; ignoruje SIGTERM (wyciek z opisu L1.6). */
const UPARTY = "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);";
/** Potomek, ktory wychodzi sam po krotkiej chwili. */
const KROTKO = 'setTimeout(() => process.exit(0), 250);';

const ppidOf = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(after[1]);
  } catch {
    return null;
  }
};

const waitFor = async (predicate: () => boolean, ms = 10_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((done) => setTimeout(done, 40));
  }
  return predicate();
};

const spawned: number[] = [];
const track = (child: ChildProcess): number => {
  if (child.pid) spawned.push(child.pid);
  return child.pid!;
};

afterAll(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* juz nie zyje */
    }
  }
});

describe('warianty recenzenta: przyrzad L1.6 (pid + czas startu)', () => {
  it.skipIf(!NA_LINUKSIE)(
    'WYSCIG: potomek zaszl przed pomiarem — przyrzad nie raportuje fantomu i nie klamie o zywym',
    async () => {
      // (i) Potomek wychodzi PRZED pomiarem: lista potomstwa jest pusta,
      // wiec tozsamosc jest pusta i `stillRunning` nie moze pokazac wycieku,
      // ktorego nie ma. Klamstwo byloby pokazanie procesu.
      const rodzic1 = spawn(process.execPath, ['-e', KROTKO], { stdio: 'ignore' });
      const r1 = track(rodzic1);
      await new Promise((done) => setTimeout(done, 600));
      expect(rodzic1.exitCode ?? rodzic1.signalCode, 'scenariusz: potomek mial wyjsc sam').not.toBeNull();
      const potomstwo1 = descendants(r1);
      expect(potomstwo1, 'proces bez potomstwa ma miec puste potomstwo').toEqual([]);
      expect(stillRunning(potomstwo1), 'przyrzad nie moze raportowac wycieku z pustej listy').toEqual([]);

      // (ii) Tozsamosc chwycona ZYWA, potomek wychodzi CHWILE PO pomiarze:
      // `stillRunning` musi zejsc do pustki — nie wolno mu wiecznie meldowac
      // proces, ktory juz nie istnieje.
      const rodzic2 = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process');` +
        `spawn(process.execPath, ['-e', ${JSON.stringify(KROTKO)}], { stdio: 'ignore' });` +
        `setInterval(() => {}, 1000);`], { stdio: 'ignore' });
      const r2 = track(rodzic2);
      expect(await waitFor(() => descendants(r2).length > 0), 'scenariusz: potomek mial sie uruchomic').toBe(true);
      const chwycone = descendants(r2);
      expect(chwycone.length).toBeGreaterThan(0);
      // W momencie pomiaru zyje — przyrzad ma go widziec.
      expect(stillRunning(chwycone).map((p) => p.pid)).toEqual(chwycone.map((p) => p.pid));
      // Czeka, az potomek sam wyjdzie.
      expect(
        await waitFor(() => stillRunning(chwycone).length === 0, 8000),
        'przyrzad melduje „zyje" o procesie, ktory wyszedl po pomiarze',
      ).toBe(true);
      // Rodzic sprzatniety, zeby nie zostawiaclokowania srodowiska.
      try {
        rodzic2.kill('SIGKILL');
      } catch {
        /* juz nie zyje */
      }
    },
    20_000,
  );

  it.skipIf(!NA_LINUKSIE)(
    'ADOPCJA: po smierci rodzica potomek ma innego rodzica, a przyrzad widzi nadal TEN SAM proces',
    async () => {
      const rodzic = spawn(
        process.execPath,
        [
          '-e',
          `const { spawn } = require('node:child_process');` +
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(UPARTY)}], { stdio: 'ignore' });` +
            `process.on('SIGTERM', () => process.exit(0));` +
            `setInterval(() => {}, 1000);`,
        ],
        { stdio: 'ignore' },
      );
      const rp = track(rodzic);
      expect(await waitFor(() => descendants(rp).length > 0), 'scenariusz: potomek mial sie uruchomic').toBe(true);

      const przed = descendants(rp);
      expect(przed.length).toBeGreaterThan(0);
      const potomek = przed[0]!;
      for (const p of przed) spawned.push(p.pid);

      // Rodzic ginie bez sprzatania (SIGKILL) — potomek musi byc przepiety.
      process.kill(rp, 'SIGKILL');
      expect(await waitFor(() => ppidOf(rp) === null), 'rodzic mial zniknac z /proc').toBe(true);

      // Adopcja potwierdzona w /proc: nowy opiekun to NIE zyje juz rodzic...
      const nowyOpiekun = ppidOf(potomek.pid);
      expect(nowyOpiekun, 'potomek zyje po smierci rodzica').not.toBeNull();
      expect(nowyOpiekun, 'potomek mial byc przepiety do innego rodzica').not.toBe(rp);

      // ...a przyrzad — bez zadnego odwolania do rodzicielstwa — widzi go jako
      // TEN SAM proces: ten sam pid, ten sam czas startu.
      const widziane = stillRunning([potomek]);
      expect(widziane.map((p) => p.pid), 'przyrzad zgubil adopted potomka').toEqual([potomek.pid]);
      expect(widziane[0]!.startTime).toBe(potomek.startTime);
      expect(widziane[0]!.comm).toBe(potomek.comm);

      // Kontrola tozsamosci: podszycie innym czasem startu odrzucone takze u
      // adoptowanego procesu.
      expect(stillRunning([{ ...potomek, startTime: `${Number(potomek.startTime) + 7}` }])).toEqual([]);

      try {
        process.kill(potomek.pid, 'SIGKILL');
      } catch {
        /* juz nie zyje */
      }
    },
    20_000,
  );
});
