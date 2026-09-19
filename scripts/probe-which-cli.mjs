#!/usr/bin/env node
/**
 * Które CLI uruchamia SDK: to wbudowane w pakiet czy to z `PATH`?
 *
 * **Po co.** Zapisane dowody uwierzytelnienia były przypięte do wersji `claude`
 * z `PATH` (`claude --version`). Aktualizacja tego CLI po stronie użytkownika —
 * 2.1.277 → 2.1.278, w nocy, bez żadnej zmiany w repozytorium — wywracała całą
 * bramkę `pnpm verify`. Zanim jednak zmieni się sposób przypinania, trzeba
 * odpowiedzieć na pytanie faktyczne: czy ten plik w ogóle brał udział w
 * przebiegu?
 *
 * **Jak to sprawdza.** Uruchamia zadanie sterujące SDK (`accountInfo()`) z
 * `PATH` **pozbawionym** katalogu, w którym leży `claude` użytkownika, i z
 * `CLAUDE_CONFIG_DIR` wskazującym katalog tymczasowy z **fabrykowanym**
 * poświadczeniem. Jeżeli mimo to SDK odpowiada, znaczy, że uruchomiło własny
 * binarny plik z pakietu `@anthropic-ai/claude-agent-sdk-<platforma>` — a
 * `claude` z `PATH` nie brał udziału w niczym.
 *
 * **Co to kosztuje.** Zero tur. `accountInfo()` jest żądaniem sterującym: CLI
 * odpowiada na nie samo, żaden prompt nie jest wysyłany i żaden model nie jest
 * pytany. Poświadczenie jest zmyślone, więc nie ma czego unieważnić, a katalog
 * poświadczeń użytkownika nie jest otwierany ani zapisywany (G21).
 *
 *   node scripts/probe-which-cli.mjs            # wypisuje obserwację
 *   APP_WRITE_EVIDENCE=1 node scripts/probe-which-cli.mjs   # + zapis dowodu
 *
 * Kryteria: L1.12, L12.10 (wersja przy dowodzie musi dotyczyć tego, co naprawdę
 * wykonało pracę).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const EVIDENCE = 'docs/evidence/z13-bl12/ktore-cli-uruchamia-sdk.json';
const require = createRequire(resolve(process.cwd(), 'packages/platform-server/package.json'));

/** Wersja i tożsamość CLI **wbudowanego** w zainstalowany pakiet SDK. */
export function sdkBundledCli() {
  let dir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  for (let i = 0; i < 6; i += 1) {
    const manifest = resolve(dir, 'manifest.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      if (json.version) {
        return { wersja: json.version, commit: json.commit ?? 'nieznany', dataBudowy: json.buildDate ?? 'nieznana' };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const shell = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')[0];
  } catch {
    return null;
  }
};

const packageVersion = (name) => {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 8; i += 1) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      if (json.name === name && json.version) return json.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'nieznana';
};

const cliOnPath = shell('claude', ['--version']);
const whichClaude = shell('which', ['claude']);
const bundled = sdkBundledCli();

/* ------------------------------ obserwacja -------------------------------- */

const { query } = await import(require.resolve('@anthropic-ai/claude-agent-sdk'));
const configDir = mkdtempSync(resolve(tmpdir(), 'ktore-cli-'));
writeFileSync(
  resolve(configDir, '.credentials.json'),
  `${JSON.stringify({
    claudeAiOauth: {
      accessToken: 'NIGDY-NIE-BYL-TOKENEM-access',
      refreshToken: 'NIGDY-NIE-BYL-TOKENEM-refresh',
      expiresAt: Date.now() - 3_600_000,
      scopes: [],
      subscriptionType: 'max',
    },
  })}\n`,
);

/** `PATH` bez katalogu, w którym leży `claude` użytkownika. */
const strippedPath = (process.env.PATH ?? '')
  .split(':')
  .filter((p) => !whichClaude || !whichClaude.startsWith(p))
  .join(':');
const env = { ...process.env, PATH: strippedPath, CLAUDE_CONFIG_DIR: configDir };
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;

async function* nigdyNic() {
  await new Promise(() => {});
}

let odpowiedz = null;
let blad = null;
try {
  const q = query({ prompt: nigdyNic(), options: { env, cwd: configDir, maxTurns: 1 } });
  odpowiedz = await Promise.race([
    q.accountInfo(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 40 s')), 40_000)),
  ]);
  await q.interrupt?.().catch(() => {});
} catch (e) {
  blad = String(e?.message ?? e).slice(0, 400);
}
rmSync(configDir, { recursive: true, force: true });

const uruchomioneBezPath = odpowiedz !== null;

const record = {
  opis:
    'Ktore CLI wykonuje prace, gdy aplikacja uzywa Claude Agent SDK: wbudowane w pakiet czy to z PATH. ' +
    'Zadanie sterujace accountInfo() z PATH pozbawionym katalogu z `claude` uzytkownika i z ' +
    'CLAUDE_CONFIG_DIR w katalogu tymczasowym z fabrykowanym poswiadczeniem.',
  zrodlo: 'node scripts/probe-which-cli.mjs',
  rodzajWykonania: 'przebieg odbiorowy z logiem',
  czegoToNieDowodzi: [
    'To nie jest tura modelu. accountInfo() jest zadaniem sterujacym — CLI odpowiada na nie samo, ' +
      'prompt nie jest wysylany, model nie jest pytany. Koszt: zero tur.',
    'To nie mowi nic o koncie uzytkownika: poswiadczenie jest zmyslone, a odpowiedz to stan sesji, ' +
      'nie dane konta.',
  ],
  zapisano: new Date().toISOString(),
  wersjaKodu: {
    commit: shell('git', ['rev-parse', 'HEAD']) ?? 'nieznany',
    brudneDrzewo: (shell('git', ['status', '--porcelain']) ?? '') !== '',
  },
  srodowisko: {
    system: `${platform()} ${release()} ${arch()}`,
    node: process.versions.node,
    claudeNaPath: cliOnPath,
    sciezkaClaudeNaPath: whichClaude,
    pakietSdk: packageVersion('@anthropic-ai/claude-agent-sdk'),
    cliWbudowaneWSdk: bundled,
  },
  warunki: {
    pathBezClaude: !strippedPath.split(':').some((p) => whichClaude && whichClaude.startsWith(p)),
    claudeConfigDir: 'katalog tymczasowy, skasowany po probie',
    poswiadczenie: 'fabrykowane — wartosci, ktore nigdy nie byly tokenem',
  },
  wynik: {
    sdkOdpowiedzialoBezClaudeNaPath: uruchomioneBezPath,
    odpowiedz: odpowiedz ? { tokenSource: odpowiedz.tokenSource ?? null, apiProvider: odpowiedz.apiProvider ?? null } : null,
    blad,
  },
  wniosek: uruchomioneBezPath
    ? `SDK wykonalo zadanie sterujace bez \`claude\` na PATH, wiec uruchomilo CLI wbudowane w pakiet ` +
      `(${bundled?.wersja ?? 'nieustalona'}, commit ${bundled?.commit ?? 'nieznany'}). ` +
      `\`claude\` z PATH (${cliOnPath ?? 'brak'}) nie bral udzialu w przebiegu — przypinanie dowodu do ` +
      'jego wersji przypina go do programu, ktory nie wykonal pracy.'
    : `SDK nie odpowiedzialo bez \`claude\` na PATH (${blad ?? 'brak bledu'}). W tym srodowisku CLI z PATH ` +
      'moze brac udzial w przebiegu — przypinanie dowodu do jego wersji jest uzasadnione.',
};

const body = `${JSON.stringify(record, null, 2)}\n`;
console.log(body);
if (process.env.APP_WRITE_EVIDENCE === '1') {
  mkdirSync(dirname(resolve(process.cwd(), EVIDENCE)), { recursive: true });
  writeFileSync(resolve(process.cwd(), EVIDENCE), body);
  console.log(`[sonda] zapisano ${EVIDENCE}`);
} else {
  console.log(`[sonda] bez zapisu (APP_WRITE_EVIDENCE=1 zapisuje do ${EVIDENCE})`);
}

/*
 * Jawne wyjscie: strumien wejsciowy sesji celowo nigdy nic nie emituje, wiec
 * trzyma petle zdarzen przy zyciu i proces bez tego wisialby po wykonaniu
 * calej pracy. Kod wyjscia mowi o wyniku obserwacji.
 */
process.exit(uruchomioneBezPath ? 0 : 1);
