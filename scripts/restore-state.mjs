#!/usr/bin/env node
/**
 * Restores a verified backup of the local state — or says why it will not.
 *
 *   node scripts/restore-state.mjs --backup backups/data-2026-09-15 --check
 *   node scripts/restore-state.mjs --backup backups/data-2026-09-15 --data data
 *
 * **Why this is a script and not a paragraph.** The procedure used to live in
 * `docs/odzyskiwanie-stanu.md` as a sequence of `mv` and `cp` commands. A
 * procedure written down is a procedure nobody has run: it cannot be exercised
 * by the regression, its failure modes are untested, and the three questions
 * that decide whether a restore is safe were not answered by it at all.
 *
 * Those three questions, which this script answers before it moves a byte:
 *
 *  1. **What happens to the state from before the attempt?** It is moved aside
 *     to `<data>.przed-odtworzeniem-<timestamp>`, never overwritten and never
 *     deleted. A restore that turns out to be the wrong one is undone by moving
 *     that directory back.
 *  2. **Is this build able to run this copy?** The migrations recorded *in the
 *     backup* are compared with the migrations this checkout knows. A copy made
 *     by a newer build carries schema changes this code cannot understand and
 *     has no way to undo — that is refused, not attempted. A copy older than the
 *     build is fine and is reported with the list of migrations that the next
 *     start will apply, which is the moment to rehearse them first.
 *  3. **What happens to sessions?** Browser sessions survive only if
 *     `session.secret` is carried over from the directory set aside — the backup
 *     deliberately does not contain it. Claude Agent SDK transcripts are not in
 *     the backup either, and are neither copied nor deleted: after a restore on
 *     another machine, conversations that carry a `claude_session_id` will find
 *     no transcript, and the application says so explicitly instead of pretending
 *     the memory came back (`session_transcript_lost`).
 *
 * Exit codes: 0 done, 1 a negative verdict (the backup did not verify, or the
 * restored state does not match its manifest), 2 refused (unsafe arguments, a
 * live database in use), 3 refused because the backup is newer than this build,
 * 4 crashed. The same contract in all four state scripts — see
 * `lib/state-tools.mjs`.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from './backup-state.mjs';
import {
  REPO,
  assertLooksLikeDataDir,
  assertNobodyHoldsIt,
  census,
  makeArgs,
  realResolve,
  refuse,
  runScript,
  tidy,
} from './lib/state-tools.mjs';

const { flag, has } = makeArgs(process.argv);

/**
 * Migration ids this checkout would apply, obtained by letting it apply them.
 *
 * Not a hard-coded list and not a read of the platform's migration array: the
 * application is platform **plus whichever modules are composed in**, and the
 * module's migrations are equally part of the schema a copy has to match. The
 * composition root is the only place that knows both, so this boots it against
 * an empty throw-away directory and reads back what ended up in
 * `schema_migrations`. A module added or swapped later is covered without
 * touching this file — and nothing here names a business module, which is what
 * keeps the platform/domain boundary intact.
 */
function knownMigrations() {
  const probe = mkdtempSync(resolve(tmpdir(), 'agentic-migration-probe-'));
  try {
    const script = `
      import { composeApp } from ${JSON.stringify(resolve(REPO, 'apps/server/src/compose.ts'))};
      const p = composeApp({ dataDir: ${JSON.stringify(probe)} });
      const ids = p.db.$client.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id);
      p.close();
      console.log('MIGRATIONS ' + JSON.stringify(ids));
    `;
    const out = execFileSync(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script],
      { cwd: REPO, env: { ...process.env, APP_DATA_DIR: probe }, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const line = out.split('\n').find((l) => l.startsWith('MIGRATIONS '));
    if (!line) throw new Error(`nie udalo sie odczytac listy migracji tego builda:\n${out}`);
    return JSON.parse(line.slice('MIGRATIONS '.length));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/* --------------------------------- main ---------------------------------- */

function main() {
  if (!flag('backup')) refuse('podaj --backup <katalog kopii>');
  const backupDir = realResolve(flag('backup'));
  /*
   * The default target is what this installation actually uses: `APP_DATA_DIR`
   * when it is set, the repository's `data/` otherwise. Defaulting to `data/`
   * regardless — as this did — meant that on an installation keeping its state
   * elsewhere, a bare `restore-state.mjs --backup …` restored into a directory
   * the application does not read.
   */
  const dataDir = realResolve(flag('data', process.env.APP_DATA_DIR || resolve(REPO, 'data')));
  const checkOnly = has('check');

  const manifestPath = resolve(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    refuse(`${backupDir} nie wyglada na kopie (brak manifest.json).`);
  }
  if (backupDir === dataDir) refuse('kopia i katalog docelowy to ten sam katalog.');


  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  /* ---- 1. the copy is actually a copy ---- */
  const problems = verify(backupDir);
  // `verify` opens the copy, which recreates its log files; the backup is left
  // as the single file it was.
  tidy(backupDir);
  if (problems.length) {
    console.error(`[odtworzenie] KOPIA NIEPOPRAWNA (${problems.length}) — nie odtwarzam:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[odtworzenie] kopia ${backupDir}: sprawdzona (sumy, census, integrity_check)`);

  /* ---- 2. can this build run it? ---- */
  const known = knownMigrations();
  const inBackup = manifest.census?.migrations ?? [];
  const unknown = inBackup.filter((id) => !known.includes(id));
  const pending = known.filter((id) => !inBackup.includes(id));

  console.log(`[odtworzenie] migracje w kopii:  ${inBackup.join(', ') || '(brak)'}`);
  console.log(`[odtworzenie] migracje w kodzie: ${known.join(', ')}`);

  if (unknown.length) {
    console.error(
      `[odtworzenie] ODMAWIAM: kopia zawiera migracje nieznane temu buildowi: ${unknown.join(', ')}.\n` +
        '              Kopia pochodzi z nowszej wersji kodu. Migracji nie da sie cofnac —\n' +
        '              odtworz ja na wersji kodu co najmniej tak nowej jak kopia.',
    );
    process.exit(3);
  }
  if (pending.length) {
    console.log(
      `[odtworzenie] kopia jest starsza niz kod: pierwszy start zastosuje ${pending.join(', ')}.\n` +
        '              Przecwicz to najpierw: node scripts/migration-rehearsal.mjs --backup ' +
        backupDir,
    );
  } else {
    console.log('[odtworzenie] kopia i kod maja ten sam zestaw migracji — start nic nie zmieni w schemacie');
  }

  /* ---- 3. what happens to sessions ---- */
  console.log(
    '[odtworzenie] sesje przegladarki: `session.secret` nie jest w kopii; jest przenoszony ze stanu ' +
      'odlozonego na bok, a bez niego wszyscy musza zalogowac sie ponownie (dane pozostaja)',
  );
  console.log(
    '[odtworzenie] transkrypty Claude Agent SDK: leza poza katalogiem danych, nie sa kopiowane ani\n' +
      '              usuwane. Pamiec modelu NIE wraca wraz z baza. Rozmowa z zapisanym\n' +
      '              claude_session_id, dla ktorej transkrypt nie istnieje, dostaje jawny wynik\n' +
      '              jedna z dwoch droga, zaleznie od tego, jak zachowa sie SDK:\n' +
      '                - odmowa wznowienia → polecenie konczy sie bledem session_transcript_lost,\n' +
      '                  a powiazanie z martwa sesja zostaje wyczyszczone;\n' +
      '                - wznowienie odpowiadajace z innej sesji → niezgodnosc identyfikatora jest\n' +
      '                  wykryta, zapisana w zdarzeniach uruchomienia i odnotowana w logu serwera,\n' +
      '                  a rozmowa zostaje przepieta na sesje, ktora istnieje.\n' +
      '              Ktora z tych drog zachodzi na prawdziwym SDK — NIE ZOSTALO ZAOBSERWOWANE\n' +
      '              (kryterium L7.13 jest z tego powodu otwarte, patrz docs/ACCEPTANCE.md).',
  );

  if (checkOnly) {
    console.log('[odtworzenie] --check: nic nie zostalo zmienione');
    process.exit(0);
  }

  /* ---- 4. put the current state aside, then restore ---- */

  /*
   * The target is *renamed*, not deleted — but renaming somebody's directory
   * because of a typo is still a mess to undo, so a non-empty target has to
   * look like a data directory before it is touched. There used to be no check
   * here at all: whatever `--data` named got moved.
   *
   * Deliberately here and not with the argument parsing: everything above this
   * point is read-only, and `--check` must be able to answer questions about a
   * backup without an opinion about where it might one day be restored.
   */
  assertLooksLikeDataDir(dataDir, { what: 'Katalog docelowy' });
  assertNobodyHoldsIt(dataDir, { label: 'odtworzenie' });

  let setAside = null;
  if (existsSync(dataDir)) {
    setAside = `${dataDir}.przed-odtworzeniem-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(dataDir, setAside);
    console.log(`[odtworzenie] stan sprzed proby odlozony: ${setAside} (nic nie zostalo usuniete)`);
  }
  mkdirSync(dataDir, { recursive: true });

  copyFileSync(resolve(backupDir, 'app.db'), resolve(dataDir, 'app.db'));
  for (const tree of ['files', 'workspaces']) {
    if (existsSync(resolve(backupDir, tree))) {
      cpSync(resolve(backupDir, tree), resolve(dataDir, tree), { recursive: true });
    }
  }
  if (setAside && existsSync(resolve(setAside, 'session.secret'))) {
    copyFileSync(resolve(setAside, 'session.secret'), resolve(dataDir, 'session.secret'));
    console.log('[odtworzenie] przeniesiono session.secret — otwarte sesje przegladarki pozostaja wazne');
  } else {
    console.log('[odtworzenie] brak session.secret do przeniesienia — zostanie wygenerowany, trzeba zalogowac sie ponownie');
  }

  /* ---- 5. read back what was restored, before anything starts ---- */
  const now = census(resolve(dataDir, 'app.db'));
  tidy(dataDir);
  const mismatches = Object.entries(manifest.census.tableCounts).filter(
    ([t, n]) => now.counts[t] !== n,
  );
  if (now.integrity !== 'ok' || mismatches.length) {
    console.error(`[odtworzenie] ODTWORZONY STAN NIE ZGADZA SIE Z KOPIA (integrity=${now.integrity}):`);
    for (const [t, n] of mismatches) console.error(`  - ${t}: ${now.counts[t]} zamiast ${n}`);
    process.exit(1);
  }

  const shown = ['conversations', 'messages', 'agent_runs', 'canvas_cards', 'files', 'artifacts'];
  console.log(
    `[odtworzenie] odtworzono: ${shown
      .filter((t) => t in now.counts)
      .map((t) => `${t}=${now.counts[t]}`)
      .join(' ')}; integrity_check ok`,
  );
  console.log(`[odtworzenie] gotowe — uruchom: pnpm build && pnpm start`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runScript('odtworzenie', main);
}

export { knownMigrations };
