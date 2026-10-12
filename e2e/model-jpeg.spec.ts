import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import type { Page } from '@playwright/test';
import {
  Backend,
  conversationIdOf,
  openApp,
  settledDeciding,
  typeCommand,
} from './support/bl03-checks.ts';
import {
  GLM_TURN_BUDGET,
  RUN_STAMP,
  budgetPreflight,
  configuredModel,
  glmMode,
  providerZrodlo,
  readLedger,
  turnUnit,
  writeLedger,
} from './support/model-turns.ts';
import { codeVersion, environment } from '../tests/support/measurement-evidence.ts';
import { ScriptedInstance } from './support/scripted.ts';

/**
 * ODCZYT TRESCI OBRAZU JPEG — domkniecie proby T24 (luka L11.21): „odczyt
 * tresci obrazu przez model sprawdzony tylko dla PNG”.
 *
 * Rodzaj dowodu: **rzeczywisty model**, przez `@mastra/claude` i proces Claude
 * Agent SDK na buildzie produkcyjnym.
 *
 * ## Co ten spec dowodzi
 *
 * Obraz w formacie JPEG pod nazwa **`wykres-kwartalny.png`** — bajty sa JPEG
 * (FF D8…FF D9), a kazdy metadany — rozszerzenie, nazwa, zgloszony MIME — mowi
 * „PNG” i nic nie mowi o tresci. Polecenie pyta o **dominujacy kolor**;
 * poprawna odpowiedz („zielony”) da sie wziac wylacznie z zdekodowanych
 * pikseli. Uzupelnia `e2e/files-agent.spec.ts`, ktory ta sama droga (kompozytor
 * → magazyn plikow → `files_stage` → workspace) sprawdzil obraz PNG z pasami:
 * tu badanym formatem jest JPEG, ktorego odczyt nie byl nigdy sprawdzany, w
 * sytuacji z zycia wzietej — plik, ktorego nazwa klamie o formacie.
 *
 * ## Kontrola przeciwna (w kopercie, dla audytu)
 *
 * Manifest zapisuje trzy pola obok siebie: `nazwaPliku`, `rozmiarBajtow` i
 * `odpowiedz` — plus wyliczone verdicty, ze nazwa ani rozmiar nie zawieraja
 * zadnej nazwy koloru. Odpowiedz nie da sie wziac z nazwy („wykres-kwartalny”),
 * z rozszerzenia ani z rozmiaru; wpisanie tego do koperty sprawia, ze audyt
 * widzi kontrole enforce'owana asercja, a nie tylko opisana w komentarzu.
 * Druga kontrola: po turze plik w magazynie jest **bajt w bajt** tym, co
 * wyslano (sha256 przed i po), wiec odpowiedz nie mogla powstac z zadnej
 * transformacji pliku po drodze.
 *
 * ## Fixture
 *
 * Generowana deterministycznie w `beforeAll`, z jednym zrodlem pikseli: plik
 * P6 PPM pisany w Node (320x240, zielen (0,128,0) i kontrastowy granatowy
 * prostokat 40x30 w gornym prawym rogu). Koder probuje po kolei: python3+PIL,
 * ImageMagick (`magick`, `convert`), ffmpeg — a gdy nie ma zadnego, dekodowana
 * jest wbudowana poprawna base64 malego jednolitego JPEG-a 64x64 (zweryfikowana
 * magic bytes i `file` przy wprowadzaniu). Kolor wybrany srodkowy, nie
 * skrajny, zeby kompresja JPEG nie znieksztalcila odpowiedzi; pomiary
 * wprowadzajace pokazaly dominante (0,128,1) — przesuniecie o 1 na kanale
 * niebieskim, bez znaczenia dla nazwy koloru.
 *
 * ## Koszt i opt-in
 *
 * Koszt: **1 tura** (jedno polecenie w kompozytorze, jedna rozmowa). Opt-in:
 * bez `APP_E2E_MODEL=1` zadny projekt nie pasuje do tego pliku
 * (`playwright.config.ts`); preflight budzetu (`budgetPreflight`) na aktywnym
 * grancie (GLM 60 w trybie glm, zamkniety grant subskrypcyjny 22 poza nim)
 * pomija CALY spec, gdy zostatek nie pokrywa kosztu — nic nie idzie do modelu.
 * Rejestr tur wspolny z pozostalymi specami projektu „model”
 * (`.e2e-model-turns/`, w trybie GLM `glm.json`).
 *
 * ## Dlaczego wlasna instancja
 *
 * Jak `e2e/bramka-przekrojowa.spec.ts`: build produkcyjny (`entry:
 * 'production'`), wlasny wolny scenariuszowo port 8792 i wlasny katalog danych
 * `.e2e-real-jpeg`; instancja nie dzieli bazy ani procesu z zadnym innym
 * zakresem. Projekt „model” biegnie sekwencyjnie (workers: 1), wiec port 8792
 * nie koliduje z bramka przekrojowa — instancje nie zyja rownoczesnie.
 */

const FILE = 'model-jpeg.spec.ts';
const AGENT_TIMEOUT = 420_000;

const instance = new ScriptedInstance({
  port: 8792,
  dataDirName: '.e2e-real-jpeg',
  entry: 'production',
  logFile: 'docs/evidence/model-jpeg/serwer.log',
});
const BASE = instance.baseUrl;

/* -------------------------------------------------------------------------- */
/*  Budget: the same ledger the „model” project books against                  */
/* -------------------------------------------------------------------------- */

/** Turns one clean run of this spec may spend — see the header. */
const JPEG_TURNS = 1;

/**
 * The subscription grant that paid for BL-01/BL-02 is **closed** (22 turns, 21
 * spent); it cannot pay this spec, and a run in subscription mode will skip
 * honestly at the preflight rather than spend from a closed grant. GLM is the
 * active provider of v0.4 and books against its own grant.
 */
const CLOSED_SUBSCRIPTION_BUDGET = 22;

const ACTIVE_BUDGET = glmMode() ? GLM_TURN_BUDGET : CLOSED_SUBSCRIPTION_BUDGET;

const preflight = budgetPreflight({
  budget: ACTIVE_BUDGET,
  spent: readLedger(ACTIVE_BUDGET).wydane,
  needed: JPEG_TURNS,
});
let preflightAnnounced = false;

/** Books one turn, refuses over the ceiling, then sends — in that order. */
async function sendForRun(page: Page, text: string, etap: string) {
  const ledger = readLedger(ACTIVE_BUDGET);
  const nr = ledger.wydane + 1;
  expect(nr, `budzet to ${ACTIVE_BUDGET} ${turnUnit()} — proba wyslania tury ${nr}`).toBeLessThanOrEqual(
    ACTIVE_BUDGET,
  );
  ledger.wydane = nr;
  ledger.tury.push({ nr, o: new Date().toISOString(), proba: 'model-jpeg', polecenie: text, etap });
  ledger.budzet = ACTIVE_BUDGET;
  /* Odmowa pierwsza, zapis drugi — tury, ktora nie opuscila przegladarki,
     nie wolno ksiegowac (lekcja tury 19 w bl01-bl02-model.spec.ts). */
  writeLedger(ledger);
  const sent = await typeCommand(page, text);
  const updated = readLedger(ACTIVE_BUDGET);
  const entry = updated.tury.find((t) => t.nr === nr);
  if (entry) entry.runId = sent.runId;
  writeLedger(updated);
  return sent;
}

/* -------------------------------------------------------------------------- */
/*  The fixture: one pixel source (P6 PPM), encoders tried in order           */
/* -------------------------------------------------------------------------- */

const IMG_W = 320;
const IMG_H = 240;
const ZIELEN: [number, number, number] = [0, 128, 0];
const PROSTOKAT: [number, number, number] = [20, 20, 96];
const PROSTOKAT_W = 40;
const PROSTOKAT_H = 30;

/** The misleading name: `.png` extension over JPEG bytes, no colour word in it. */
const PLIK_NAZWA = 'wykres-kwartalny.png';
/** Name as the real browser would send it: MIME derived from the extension. */
const PLIK_MIME = 'image/png';
/** The question — about the pixels, answerable from nothing else. */
const POLECENIE = 'Jaki jest dominujacy kolor tego obrazu? Odpowiedz jednym slowem po polsku.';

/**
 * A valid, small JPEG of one uniform colour (0,128,0), 64x64 — the last-resort
 * fixture when no encoder is installed. Verified at introduction: magic bytes
 * FF D8 FF / trailer FF D9, `file(1)` says „JPEG image data … baseline”, PIL
 * re-opens it and reads back (0,128,1) everywhere.
 */
const FALLBACK_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5yooor8PP5vCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/2Q==';

const PIL_SCRIPT =
  "import sys; from PIL import Image; Image.open(sys.argv[1]).save(sys.argv[2], 'JPEG', quality=95)";

/** The one pixel source every encoder shares — P6 PPM is trivially correct. */
function pixelsPpm(): Buffer {
  const raw = Buffer.alloc(IMG_W * IMG_H * 3);
  for (let y = 0; y < IMG_H; y += 1) {
    for (let x = 0; x < IMG_W; x += 1) {
      const wRogu = x >= IMG_W - PROSTOKAT_W && y < PROSTOKAT_H;
      const c = wRogu ? PROSTOKAT : ZIELEN;
      const p = (y * IMG_W + x) * 3;
      raw[p] = c[0];
      raw[p + 1] = c[1];
      raw[p + 2] = c[2];
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${IMG_W} ${IMG_H}\n255\n`), raw]);
}

interface Fixture {
  bytes: Buffer;
  /** Which encoder produced the bytes — recorded in the manifest. */
  narzedzie: string;
  wymiary: string;
}

/**
 * Generates the JPEG fixture, trying the encoders in the declared order and
 * falling back to the embedded bytes only when none exists. The magic-bytes
 * check below the call site is what makes every path honest: whatever produced
 * the bytes, they are a JPEG before the trial starts.
 */
function generateJpegFixture(dir: string): Fixture {
  const ppmPath = resolve(dir, 'pixel-source.ppm');
  const jpgPath = resolve(dir, 'fixture.jpeg');
  writeFileSync(ppmPath, pixelsPpm());

  try {
    execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
    execFileSync('python3', ['-c', PIL_SCRIPT, ppmPath, jpgPath], { stdio: 'ignore' });
    return {
      bytes: readFileSync(jpgPath),
      narzedzie: 'python3+PIL (P6 PPM → JPEG, quality=95)',
      wymiary: `${IMG_W}x${IMG_H}`,
    };
  } catch {
    /* nastepne narzedzie */
  }
  for (const tool of ['magick', 'convert'] as const) {
    try {
      execFileSync(tool, [ppmPath, '-quality', '95', jpgPath], { stdio: 'ignore' });
      return {
        bytes: readFileSync(jpgPath),
        narzedzie: `ImageMagick ${tool} (P6 PPM → JPEG, quality=95)`,
        wymiary: `${IMG_W}x${IMG_H}`,
      };
    } catch {
      /* nastepne narzedzie */
    }
  }
  try {
    execFileSync('ffmpeg', ['-y', '-i', ppmPath, '-q:v', '2', jpgPath], { stdio: 'ignore' });
    return {
      bytes: readFileSync(jpgPath),
      narzedzie: 'ffmpeg (P6 PPM → JPEG, -q:v 2)',
      wymiary: `${IMG_W}x${IMG_H}`,
    };
  } catch {
    /* fallback base64 */
  }
  return {
    bytes: Buffer.from(FALLBACK_JPEG_B64, 'base64'),
    narzedzie: 'wbudowane base64 64x64 jednolita zielen (zapasowe, brak kodera)',
    wymiary: '64x64',
  };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Every colour word the answer could carry — the filename/size control uses it. */
const NAZWY_KOLOROW = [
  'zielon',
  'czerwon',
  'niebiesk',
  'zolty',
  'czarny',
  'bialy',
  'pomarancz',
  'fiolet',
  'rozow',
  'szary',
  'brunatn',
  'branz',
] as const;

/* -------------------------------------------------------------------------- */
/*  The shared envelope — one manifest for the whole trial                     */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const EVIDENCE_DIR = resolve(REPO_ROOT, 'docs/evidence/model-jpeg');
const MANIFEST_PATH = resolve(EVIDENCE_DIR, 'manifest.json');

/**
 * Everything the trial gathered. Written into the manifest by `saveManifest`,
 * which the test's `finally` and `afterAll` call — a failure at any step leaves
 * what is known **so far** on disk, which is what makes a failed probe a
 * finding rather than silence.
 */
const gate: {
  fixture: Record<string, unknown>;
  identyfikatory: Record<string, unknown>;
  kontrola: Record<string, unknown>;
  wynik: string;
} = { fixture: {}, identyfikatory: {}, kontrola: {}, wynik: 'niezakonczona' };

function saveManifest(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      {
        zapisano: new Date().toISOString(),
        rodzajWykonania: 'rzeczywisty model',
        /* Koperta pochodzenia — ten sam ksztalt co dowody z11 (wersjaKodu). */
        wersjaKodu: codeVersion(undefined, [relative(REPO_ROOT, EVIDENCE_DIR)]),
        srodowisko: environment(),
        zrodlo: providerZrodlo(),
        model: configuredModel(),
        spec: `e2e/${FILE}`,
        przebieg: RUN_STAMP,
        instancja: {
          entry: 'production',
          port: 8792,
          dataDirName: '.e2e-real-jpeg',
          origin: BASE,
          log: 'docs/evidence/model-jpeg/serwer.log',
        },
        koszt: (() => {
          const l = readLedger(ACTIVE_BUDGET);
          return { deklarowaneTury: JPEG_TURNS, budzet: l.budzet, wydane: l.wydane };
        })(),
        ...gate,
      },
      null,
      2,
    )}\n`,
  );
}

/* -------------------------------------------------------------------------- */
/*  The trial                                                                  */
/* -------------------------------------------------------------------------- */

test.describe('obraz JPEG pod mylaca nazwa .png: model czyta tresc, nie metadane', () => {
  test.describe.configure({ mode: 'serial', timeout: AGENT_TIMEOUT });

  let fixtureDir = '';
  let fixture: Fixture;

  test.beforeEach(() => {
    if (!preflight.ok && !preflightAnnounced) {
      preflightAnnounced = true;
      console.log(`[e2e] ${preflight.message}`);
    }
    test.skip(!preflight.ok, preflight.ok ? '' : preflight.message);
  });

  test.beforeAll(() => {
    fixtureDir = mkdtempSync(resolve(tmpdir(), 'agenticapp-e2e-jpeg-'));
    fixture = generateJpegFixture(fixtureDir);
    gate.fixture = {
      narzedzie: fixture.narzedzie,
      wymiary: fixture.wymiary,
      bajty: fixture.bytes.length,
      sha256: sha256(fixture.bytes),
      kolorDominujacy: `rgb(${ZIELEN.join(', ')}) = „zielony”`,
      prostokatWRogu: `rgb(${PROSTOKAT.join(', ')}) ${PROSTOKAT_W}x${PROSTOKAT_H}, gorny prawy rog`,
    };
    /* Setup jest czescia proby: bajty maja byc JPEG, mimo ze nazwa mowi PNG. */
    expect(
      fixture.bytes.subarray(0, 3).toString('hex'),
      'fixture nie jest JPEG (magic bytes FF D8 FF)',
    ).toBe('ffd8ff');
    expect(fixture.bytes.subarray(fixture.bytes.length - 2).toString('hex'), 'brak koncowki FF D9').toBe(
      'ffd9',
    );
    expect(
      fixture.bytes.subarray(0, 8).toString('hex'),
      'fixture zaczyna sie od sygnatury PNG — proba stracila sens',
    ).not.toBe('89504e470d0a1a0a');
  });

  test.afterAll(async () => {
    await instance.stop();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    saveManifest();
  });

  test('model podaje dominujacy kolor z pikseli JPEG mimo nazwy .png', async ({ page }) => {
    test.setTimeout(2 * AGENT_TIMEOUT);
    const backend = new Backend(page, BASE);
    try {
      await instance.prepareDatabase();
      await instance.start('-');
      await openApp(page, BASE);
      gate.identyfikatory['sha256WyslanychBajtow'] = sha256(fixture.bytes);

      /* ---------------------- upload przez kompozytor ---------------------- */
      /* MimeType pochodny od rozszerzenia — tak wysla go prawdziwa przegladarka:
         kazdy metadany mowi „PNG”, bajty sa JPEG. */
      await page
        .getByTestId('chat-attach-input')
        .setInputFiles({ name: PLIK_NAZWA, mimeType: PLIK_MIME, buffer: fixture.bytes });
      await expect(page.getByTestId('chat-attachment-list')).toContainText(PLIK_NAZWA, {
        timeout: 30_000,
      });

      /* ---------------------------- jedna tura ----------------------------- */
      const run = await sendForRun(page, POLECENIE, 'obraz-jpeg-dominujacy-kolor');
      const conversationId = conversationIdOf(page);
      expect(conversationId, 'rozmowa nie ma identyfikatora w adresie').toBeTruthy();
      gate.identyfikatory['rozmowa'] = conversationId;

      /* Zgoda po drodze, gdyby model dekodowal obraz kodem w sandboxie
         (Bash); odczyt bez kodu zgody nie potrzebuje. Decyzje trafiaja do
         koperty — dowodza, ktora droga szlo wykonanie. */
      const { phase, decisions } = await settledDeciding(page, run.runId, () => 'Zgoda');
      expect(phase, `run zakonczyl sie faza ${phase}`).toBe('succeeded');
      gate.identyfikatory['run'] = run.runId;
      gate.identyfikatory['zgody'] = decisions;

      /* ------------------- plik w magazynie, bajt w bajt ------------------- */
      const files = await backend.json<{
        files: Array<{
          id: string;
          filename: string;
          version: number;
          mediaType?: string;
          byteSize: number;
          sha256: string;
        }>;
      }>('/api/files');
      const plik = files.files.find((f) => f.filename === PLIK_NAZWA && f.version === 1);
      expect(plik, 'pliku nie ma w magazynie plikow').toBeTruthy();
      gate.identyfikatory['plik'] = {
        id: plik!.id,
        mediaType: plik!.mediaType ?? null,
        byteSize: plik!.byteSize,
      };

      const poTurze = Buffer.from(
        await page.evaluate(async (id) => {
          const res = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
          return Array.from(new Uint8Array(await res.arrayBuffer()));
        }, plik!.id),
      );
      expect(
        Buffer.compare(poTurze, fixture.bytes),
        'plik po turze rozni sie od wyslanych bajtow',
      ).toBe(0);
      gate.kontrola['sha256PoTurze'] = sha256(poTurze);
      gate.kontrola['plikBajtWBajtNietkniety'] = true;

      /* ------------------- kontrola przeciwna: nazwa i rozmiar ------------- */
      const nazwaZdradza = NAZWY_KOLOROW.some((k) => PLIK_NAZWA.toLowerCase().includes(k));
      const rozmiarZdradza = NAZWY_KOLOROW.some((k) => String(fixture.bytes.length).includes(k));
      expect(nazwaZdradza, 'nazwa pliku zawiera nazwe koloru — kontrola stracila sens').toBe(false);
      expect(rozmiarZdradza, 'rozmiar pliku zawiera nazwe koloru — kontrola stracila sens').toBe(
        false,
      );
      gate.kontrola['nazwaPliku'] = PLIK_NAZWA;
      gate.kontrola['zgloszonyMimeType'] = PLIK_MIME;
      gate.kontrola['rozmiarBajtow'] = fixture.bytes.length;
      gate.kontrola['nazwaNieZawieraOdpowiedzi'] = !nazwaZdradza;
      gate.kontrola['rozmiarNieZawieraOdpowiedzi'] = !rozmiarZdradza;

      /* ------------------------ odpowiedz modelu --------------------------- */
      /* Asercja jest o dominancie, nie o prozie: modelowi kazano odpowiedziec
         jednym slowem, ale komentarz o prostokacie w rogu nie jest bledem —
         bledem bylaby odpowiedz bez „zielon*”. Cala wypowiedz leci do koperty
         (pole odpowiedz), zeby audyt widzial wiecej niz werdykt regexa. */
      const odpowiedz = await backend.assistantText(conversationId!);
      expect(
        odpowiedz.toLowerCase(),
        `odpowiedz nie nazywa zielonego; odpowiedz modelu: ${JSON.stringify(odpowiedz)}`,
      ).toMatch(/zielon/);
      gate.kontrola['odpowiedz'] = odpowiedz;

      gate.wynik = 'zaliczona';
    } finally {
      saveManifest();
    }
  });
});
