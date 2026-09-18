import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SdkSession } from '@platform/contracts';

/**
 * The recorded answer of the SDK session probe, kept honest by the regression.
 *
 * The probe itself starts the Claude CLI, so it is not something `pnpm verify`
 * should do on every run — it is an acceptance script with a recorded result
 * (`node --experimental-transform-types scripts/probe-sdk-session.ts`). What
 * belongs in the regression is the thing that goes wrong with recorded
 * evidence: it **stops matching the code**. A record taken against SDK 0.3.270
 * says nothing about 0.4, and a compatibility claim whose versions have moved
 * on is worse than no claim, because it still reads as a confirmation.
 *
 * So this file asserts three things about the record and nothing about the
 * account: that it exists, that it is conclusive, and that the versions it was
 * taken on are the versions installed right now. An upgrade of the SDK, the
 * adapter or the CLI fails here, by name, with the command to re-take it.
 *
 * L8.8 asks for the compatibility of *this* SDK, *this* adapter and *this* way
 * of signing in to be checked by a real call. The real call is in the record;
 * this is what keeps the record about the code in the tree.
 */

const EVIDENCE = 'docs/evidence/z12-bl04/sesja-sdk.json';
const REGENERATE =
  'node --experimental-transform-types --no-warnings=ExperimentalWarning scripts/probe-sdk-session.ts';

interface Record_ {
  rodzajDowodu?: string;
  wersje?: Record<string, string>;
  przebiegi?: Record<string, { warunki?: string; wynik?: SdkSession }>;
  wniosek?: string;
  czegoToNieDowodzi?: string[];
}

const require = createRequire(resolve(process.cwd(), 'packages/platform-server/src/index.ts'));
const installedVersion = (name: string): string => {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 8; i += 1) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
      if (json.name === name && json.version) return json.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'nieznana';
};

const cliVersion = (): string | null => {
  try {
    return (
      execFileSync('claude', ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split('\n')[0] ?? null
    );
  } catch {
    return null;
  }
};

describe('zapisany dowod sposobu logowania sesji SDK', () => {
  const path = resolve(process.cwd(), EVIDENCE);
  const present = existsSync(path);
  const record: Record_ = present ? (JSON.parse(readFileSync(path, 'utf8')) as Record_) : {};

  it('dowod istnieje i jest opisany jako rzeczywiste wywolanie, nie symulacja', () => {
    expect(present, `brak ${EVIDENCE}. Wykonaj: ${REGENERATE}`).toBe(true);
    expect(record.rodzajDowodu).toContain('rzeczywiste wywolanie SDK');
    // And it says plainly what it is not, so nobody reads a reading of the
    // plan limits as an exhausted limit.
    expect(record.czegoToNieDowodzi?.join(' ')).toContain('wyczerpania limitu');
  });

  it('przebieg w srodowisku aplikacji poszedl przez subskrypcje, bez klucza API', () => {
    const wynik = record.przebiegi?.srodowiskoAplikacji?.wynik;
    expect(wynik?.state).toBe('subscription');
    expect(wynik?.apiKeySource).toBeNull();
    expect(wynik?.apiProvider).toBe('firstParty');
    expect(wynik?.subscriptionType).toBeTruthy();
  });

  it('klucz API w procesie nadrzednym nie zmienil sciezki przebiegu', () => {
    // The case L8.3 names: an operator with a key exported in their shell.
    expect(record.przebiegi?.kluczApiWProcesieNadrzednym?.wynik?.state).toBe('subscription');
  });

  it('ten sam klucz przy wylaczonej polityce JEST widziany — sonda nie jest slepa', () => {
    /*
     * The control that makes the two assertions above mean something. Without
     * it "subscription, subscription" could equally be a probe that cannot see
     * an API key at all.
     */
    const wynik = record.przebiegi?.kluczApiPrzyWylaczonejPolityce?.wynik;
    expect(wynik?.state).toBe('api_key');
    expect(wynik?.apiKeySource).toBe('ANTHROPIC_API_KEY');
    // An API-key session has no plan, which is the second observable difference.
    expect(wynik?.subscriptionType).toBeNull();
    expect(wynik?.planLimits?.available).toBe(false);
  });

  it('dowod nie niesie danych konta', () => {
    const serialized = JSON.stringify(record);
    expect(/[a-z0-9._-]+@[a-z0-9.-]+/i.test(serialized), 'adres e-mail w dowodzie').toBe(false);
    expect(/organization/i.test(serialized), 'nazwa organizacji w dowodzie').toBe(false);
    expect(/sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}/.test(serialized), 'klucz API w dowodzie').toBe(false);
  });

  it('wersje, na ktorych wziety jest dowod, to wersje zainstalowane teraz', () => {
    /*
     * The assertion that keeps a recorded fact from outliving its code. Both
     * halves of the triple are checked: the SDK and the adapter come from the
     * lockfile, and the CLI from the machine — a compatibility statement about
     * a way of signing in cannot skip the thing that does the signing in.
     */
    expect(record.wersje?.claudeAgentSdk, `dowod z innej wersji SDK. Wykonaj: ${REGENERATE}`).toBe(
      installedVersion('@anthropic-ai/claude-agent-sdk'),
    );
    expect(record.wersje?.mastraClaude, `dowod z innej wersji adaptera. Wykonaj: ${REGENERATE}`).toBe(
      installedVersion('@mastra/claude'),
    );
    const cli = cliVersion();
    if (cli === null) {
      // Stated, not assumed: without the CLI the triple cannot be checked here,
      // and the record's own value is left to speak for itself.
      expect(record.wersje?.claudeCli).toBeTruthy();
      return;
    }
    expect(record.wersje?.claudeCli, `dowod z innej wersji Claude CLI. Wykonaj: ${REGENERATE}`).toBe(cli);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Zapisane próby graniczne uwierzytelnienia — i to, żeby nie przeżyły swojego SDK.
 *
 * Ta sama zasada, co wyżej: przebieg jest w pliku, a regresja pilnuje, żeby plik dotyczył
 * zainstalowanej wersji i żeby nie zaczął opowiadać czegoś, czego nie zaobserwowano. Dodatkowo
 * sprawdza dwie rzeczy, które są warunkiem odbioru tego pakietu: że próba **nie wydała tury**
 * i że **nie tknęła logowania użytkownika**.
 */
describe('zapisane proby graniczne uwierzytelnienia', () => {
  const dir = resolve(process.cwd(), 'docs/evidence/z12-bl04');
  const newest = (prefix: string): { name: string; body: any } | null => {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${prefix}-2`) && f.endsWith('.json'))
      .sort();
    const name = files.at(-1);
    if (!name) return null;
    return { name, body: JSON.parse(readFileSync(resolve(dir, name), 'utf8')) };
  };

  it('oba zapisane przebiegi niosa ten sam komunikat SDK — porownanie danych, nie funkcji', () => {
    /*
     * Asercja nad **dwoma plikami dowodowymi**, nie nad wynikiem czystej funkcji porównanym z samym
     * sobą. Utrwala to, co faktycznie zaobserwowano: przy poświadczeniu z nieprawidłowym refresh
     * tokenem tekst nie zależy od tego, czy access token wygasł. Gdy przyszła wersja SDK zacznie
     * rozróżniać te ustawienia, ten test przestanie opisywać rzeczywistość — i o to chodzi.
     *
     * Czego NIE mówi: że SDK myli odwołane logowanie z odmową odnowienia. Żaden z tych przebiegów
     * nie wytworzył odwołanego logowania (oba mają tak samo nieprawidłowy refresh token).
     */
    const a = newest('refresh-refused');
    const b = newest('revoked');
    expect(a, 'brak zapisu refresh-refused').not.toBeNull();
    expect(b, 'brak zapisu revoked').not.toBeNull();
    expect(a!.body.wynik.komunikatSdk).toBe(b!.body.wynik.komunikatSdk);
    // Warunki obu przebiegów muszą się RÓŻNIĆ, inaczej porównanie wyżej nie ma o czym mówić.
    expect(a!.body.warunki.expiresAt).not.toBe(b!.body.warunki.expiresAt);
    expect(b!.body.warunki.czegoTenTrybNIEodtwarza).toContain('NIE jest odwolane logowanie');
  });

  for (const [prefix, opis] of [
    ['refresh-refused', 'termin w przeszlosci, martwy refresh token'],
    ['revoked', 'termin w przyszlosci, martwy access token'],
  ] as const) {
    describe(`${prefix} (${opis})`, () => {
      const found = newest(prefix);

      it('przebieg jest zapisany i oznaczony jako rzeczywisty, nie jako proba generalna', () => {
        expect(found, `brak zapisu proby "${prefix}" w docs/evidence/z12-bl04`).not.toBeNull();
        expect(found!.body.rodzajDowodu).toContain('rzeczywisty przebieg');
      });

      it('nie wydal tury subskrypcji', () => {
        expect(found!.body.turySubskrypcji).toBe(0);
      });

      it('logowanie uzytkownika pozostalo nietkniete', () => {
        // Odciski obu tokenów przed i po; różnica znaczyłaby, że próba dotknęła pliku użytkownika.
        expect(found!.body.logowanieUzytkownika?.nietkniete).toBe(true);
        expect(found!.body.logowanieUzytkownika?.przed?.accessTokenSha).toBe(
          found!.body.logowanieUzytkownika?.po?.accessTokenSha,
        );
        expect(found!.body.logowanieUzytkownika?.przed?.refreshTokenSha).toBe(
          found!.body.logowanieUzytkownika?.po?.refreshTokenSha,
        );
      });

      it('aplikacja sklasyfikowala rzeczywisty komunikat jako odmowe odnowienia', () => {
        expect(found!.body.wynik?.kodBledu).toBe('unauthenticated');
        expect(found!.body.wynik?.klasyfikacjaAplikacji).toBe('refresh_refused');
        expect(found!.body.wynik?.stanDostepuPoPrzebiegu).toBe('refresh_refused');
        expect(found!.body.wynik?.komunikatSdk).toContain('OAuth session expired');
      });

      it('CLI skasowalo poswiadczenie proby na dysku — obserwacja, nie zalozenie', () => {
        /*
         * To jest powód, dla którego każda próba uwierzytelnienia MUSI iść na kopii: przy odmowie
         * CLI czyści plik, na który je skierowano. Gdyby ktoś wycelował tę próbę w ~/.claude,
         * użytkownik zostałby wylogowany natychmiast.
         */
        expect(found!.body.poswiadczenieProbyPoPrzebiegu?.skasowanePrzezCli).toBe(true);
      });

      it('zapis pochodzi z zainstalowanej wersji CLI', () => {
        const cli = cliVersion();
        if (cli === null) {
          expect(found!.body.wersje?.claudeCli).toBeTruthy();
          return;
        }
        expect(
          found!.body.wersje?.claudeCli,
          `zapis proby "${prefix}" z innej wersji CLI. Powtorz: node --experimental-transform-types ` +
            `scripts/probe-refresh-refused.ts${prefix === 'revoked' ? ' --revoked' : ''}`,
        ).toBe(cli);
      });
    });
  }
});
