import type { CallRecord, Step } from './scripted-agent.ts';

/**
 * Scenarios for the files / sandbox / background-work suite (BL-09).
 *
 * Each one is a *whole conversation*: the steps are chosen from the user's
 * message, so one scripted instance can answer several commands differently —
 * which is what a browser test needs when the point is what happens between two
 * commands (a refusal, a reload, a restart).
 *
 * The scripts below do real work: they write files into the run workspace and
 * run real Node scripts there, exactly where a sandboxed `Bash` command would.
 * Only the model is scripted; the tools, the gate, the publication and the
 * cleanup are the application's own.
 */

/** Joined rather than a template literal so the embedded script stays readable. */
const script = (...lines: string[]) => lines.join('\n');

/**
 * Reads every staged input file and prints something derived from its **bytes**.
 *
 * Deliberately not the name, the size or the media type: the point of the
 * attachment criterion is that the run received the content. A CSV is summed, a
 * text file is searched for a marker, a workbook is opened and its sheets
 * listed, an image's dimensions are read out of its header.
 */
const READ_INPUTS = script(
  "import { readdirSync, readFileSync } from 'node:fs';",
  "import { createHash } from 'node:crypto';",
  "import ExcelJS from 'exceljs';",
  '',
  'const jpegSize = (bytes) => {',
  '  let i = 2;',
  '  while (i + 9 < bytes.length) {',
  '    if (bytes[i] !== 0xff) { i += 1; continue; }',
  '    const marker = bytes[i + 1];',
  '    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }',
  '    const len = bytes.readUInt16BE(i + 2);',
  '    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {',
  "      return bytes.readUInt16BE(i + 7) + 'x' + bytes.readUInt16BE(i + 5);",
  '    }',
  '    i += 2 + len;',
  '  }',
  "  return 'nieznane';",
  '};',
  '',
  'const facts = [];',
  "for (const name of readdirSync('input').sort()) {",
  "  const bytes = readFileSync('input/' + name);",
  "  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 12);",
  "  let fact = 'brak';",
  "  if (name.endsWith('.csv')) {",
  "    const rows = bytes.toString('utf8').trim().split('\\n').slice(1);",
  "    fact = 'suma=' + rows.reduce((a, r) => a + Number(r.split(';')[1] || 0), 0);",
  "  } else if (name.endsWith('.txt')) {",
  "    fact = 'haslo=' + ((bytes.toString('utf8').match(/HASLO-[A-Z0-9]+/) || ['brak'])[0]);",
  "  } else if (name.endsWith('.xlsx')) {",
  '    const wb = new ExcelJS.Workbook();',
  '    await wb.xlsx.load(bytes);',
  "    fact = 'arkusze=' + wb.worksheets.map((w) => w.name).join('|');",
  "  } else if (name.endsWith('.png')) {",
  "    fact = 'wymiary=' + bytes.readUInt32BE(16) + 'x' + bytes.readUInt32BE(20);",
  "  } else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {",
  "    fact = 'wymiary=' + jpegSize(bytes);",
  '  }',
  "  facts.push(name + ' bajty=' + bytes.length + ' sha=' + sha + ' ' + fact);",
  '}',
  "console.log(facts.join(' ;; '));",
);

/**
 * Opens the attached workbook, reads every sheet and every cell type, and writes
 * a changed copy into `output/`.
 *
 * The summary sheet is written with the types on purpose — a number, a date, a
 * boolean and a formula — because the criterion is about the *produced* file
 * keeping them, not only about the source being read. The formula is written
 * without a value, which is the platform's stated semantics: a formula the run
 * writes has not been calculated by anything, and nothing may present it as a
 * result.
 */
const PROCESS_WORKBOOK = script(
  "import { readdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "import ExcelJS from 'exceljs';",
  '',
  "const name = readdirSync('input').find((f) => f.endsWith('.xlsx'));",
  "if (!name) throw new Error('brak skoroszytu w input/');",
  'const wb = new ExcelJS.Workbook();',
  "await wb.xlsx.load(readFileSync('input/' + name));",
  '',
  'const types = [];',
  'let total = 0;',
  'for (const sheet of wb.worksheets) {',
  '  sheet.eachRow((row) => {',
  '    row.eachCell({ includeEmpty: true }, (cell) => {',
  '      const v = cell.value;',
  "      if (v === null || v === undefined) types.push('pusta');",
  "      else if (v instanceof Date) types.push('data');",
  "      else if (typeof v === 'boolean') types.push('logiczna');",
  "      else if (typeof v === 'object' && v.formula) types.push('formula');",
  "      else if (typeof v === 'number') types.push('liczba');",
  "      else types.push('tekst');",
  '    });',
  '  });',
  '}',
  '',
  '/*',
  ' * An empty cell is read on purpose rather than hoped for: iteration covers a',
  " * row's used range, and a trailing empty cell is simply not in it. The fixture",
  ' * leaves Metryka!B3 empty, so reading it is a statement about a cell type.',
  ' */',
  "const metryka = wb.getWorksheet('Metryka');",
  "const emptyCell = metryka ? metryka.getCell('B3').value : undefined;",
  "if (emptyCell === null || emptyCell === undefined) types.push('pusta');",
  '',
  "const items = wb.getWorksheet('Pozycje');",
  'if (items) {',
  '  items.eachRow((row, i) => {',
  '    if (i === 1) return;',
  '    const qty = row.getCell(2).value;',
  '    const price = row.getCell(3).value;',
  "    if (typeof qty === 'number' && typeof price === 'number') total += qty * price;",
  '  });',
  '}',
  '',
  "const summary = wb.addWorksheet('Podsumowanie');",
  "summary.getCell('A1').value = 'Razem';",
  "summary.getCell('B1').value = total;",
  "summary.getCell('A2').value = 'Data przetworzenia';",
  "summary.getCell('B2').value = new Date('2026-03-01T00:00:00Z');",
  "summary.getCell('A3').value = 'Zatwierdzone';",
  "summary.getCell('B3').value = false;",
  "summary.getCell('A4').value = 'Kontrola';",
  "summary.getCell('B4').value = { formula: 'B1*2' };",
  '',
  "writeFileSync('output/oferty-poprawione.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));",
  "console.log('arkusze=' + wb.worksheets.map((w) => w.name).join('|') + ' typy=' +",
  "  [...new Set(types)].sort().join('|') + ' suma=' + total);",
);

/** Opens the attached workbook and reports the failure honestly if it is broken. */
const OPEN_WORKBOOK = script(
  "import { readdirSync, readFileSync } from 'node:fs';",
  "import ExcelJS from 'exceljs';",
  "const name = readdirSync('input').find((f) => f.endsWith('.xlsx'));",
  'const wb = new ExcelJS.Workbook();',
  "await wb.xlsx.load(readFileSync('input/' + name));",
  "console.log('arkusze=' + wb.worksheets.map((w) => w.name).join('|'));",
);

/** Names this scenario publishes under; never an input to work on. */
const PUBLISHED_NAMES = ['oferty-poprawione.xlsx', 'oferty-artefakt.xlsx'];

/** The CSV the L9.7 scenario publishes a version of, from the run's own listing. */
const l97Original = (calls: CallRecord[]): string => {
  const listed = calls.find((c) => c.name === 'files_list');
  const file = (listed?.result?.files ?? []).find((f: { filename: string }) => f.filename.endsWith('.csv'));
  if (!file) throw new Error('scenariusz: brak pliku CSV w magazynie');
  return file.id as string;
};

/**
 * L9.7: a retry of a write carries the same `operationId`, and one effect comes
 * out.
 *
 * Each creating tool is called **twice with the same key** — the shape of an
 * agent retrying after a reconnect — plus, for `canvas_add_card`, once with no
 * key at all, which the schema now refuses before the handler runs. The tool
 * answers are only half the proof (the browser spec reads them from the run's
 * events); the other half is what the database and the other screens show, and
 * that is where the spec's assertions live.
 *
 * The repeats are deliberate and identical, input for input: that is what makes
 * the store's answer a replay rather than a fresh write. A scenario that varied
 * the input would end in a `conflict` — a different guard, tested elsewhere.
 */
export const idempotencyScript = (prompt: string): Step[] => {
  if (!prompt.includes('powtorka')) {
    return [{ kind: 'text', text: 'Nie rozpoznano polecenia testowego.' }];
  }
  const cardInput = {
    title: 'L97 KARTA POWTORZONA',
    spec: { kind: 'component' as const, component: 'platform.markdown', props: { markdown: 'L97' } },
    operationId: 'e2e-l97-karta-1',
  };
  const viewInput = {
    title: 'L97 WIDOK POWTORZONY',
    source: 'root = TextContent("L97")',
    operationId: 'e2e-l97-widok-1',
  };
  return [
    { kind: 'call', name: 'files_list', maxChars: 400 },
    { kind: 'call', name: 'canvas_add_card', input: cardInput, maxChars: 300 },
    /* The retry: same key, same everything — one card, not two. */
    { kind: 'call', name: 'canvas_add_card', input: cardInput, maxChars: 300 },
    /* No key: the schema refuses this before any handler runs. */
    {
      kind: 'call',
      name: 'canvas_add_card',
      input: {
        title: 'L97 KARTA BEZ KLUCZA',
        spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'L97' } },
      },
      maxChars: 300,
    },
    { kind: 'call', name: 'agent_view_create', input: viewInput, maxChars: 300 },
    { kind: 'call', name: 'agent_view_create', input: viewInput, maxChars: 300 },
    { kind: 'writeOutput', path: 'l97-wynik.csv', content: 'nazwa;ilosc\nkrzeslo;7\n' },
    {
      kind: 'call',
      name: 'files_publish_version',
      input: (calls: CallRecord[]) => ({
        path: 'l97-wynik.csv',
        originalFileId: l97Original(calls),
        filename: 'l97-poprawione.csv',
        operationId: 'e2e-l97-wersja-1',
      }),
      maxChars: 400,
    },
    { kind: 'call', name: 'files_publish_version', input: (calls: CallRecord[]) => ({
        path: 'l97-wynik.csv',
        originalFileId: l97Original(calls),
        filename: 'l97-poprawione.csv',
        operationId: 'e2e-l97-wersja-1',
      }), maxChars: 400 },
    { kind: 'text', text: 'L97-KONIEC' },
  ];
};

/**
 * The workbook this conversation is working on, from the run's own listing.
 *
 * The **newest** attached spreadsheet, which is the one the command carried:
 * `files_list` answers newest first, and by the time several tests have run the
 * store also holds their results and their other attachments. Picking "the first
 * .xlsx that is not a published result" used to mean "some earlier test's file"
 * once there was more than one.
 */
const attachedWorkbook = (calls: CallRecord[]): string => {
  const listed = calls.find((c) => c.name === 'files_list');
  const file = (listed?.result?.files ?? []).find(
    (f: { filename: string }) =>
      f.filename.endsWith('.xlsx') && !PUBLISHED_NAMES.includes(f.filename),
  );
  if (!file) throw new Error('scenariusz: brak skoroszytu w magazynie');
  return file.id as string;
};

/**
 * Consent: the run writes a script, asks before running it, and publishes a
 * result **only** if the user says yes.
 *
 * The published thing is an ordinary artifact, so "did the operation happen" is
 * a question the browser can answer by looking, rather than by trusting the
 * answer text.
 */
export const consentScript = (prompt: string): Step[] => {
  /*
   * One publication identifier per command, derived from the command.
   *
   * Fixed for a given command, so a repeat of *that* command publishes once;
   * different between commands, so two runs in one test cannot quietly share a
   * result — which would make "exactly one artifact" true for the wrong reason.
   */
  const operationId = `zgoda-${prompt.replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'domyslna'}`;
  return prompt.includes('bez zgody')
    ? [{ kind: 'text', text: 'Nic nie wymaga zgody.', delayMs: 100 }]
    : [
        { kind: 'text', text: 'Przygotowalem skrypt. ', delayMs: 150 },
        {
          kind: 'ask',
          toolName: 'Bash',
          input: { command: 'node przetworz.mjs' },
          then: [
            {
              kind: 'call',
              name: 'artifact_create',
              input: {
                title: 'Wynik po zgodzie',
                kind: 'report',
                rendererType: 'platform.markdown',
                content: { text: 'Operacja wykonana po zgodzie uzytkownika.' },
                operationId,
              },
              maxChars: 200,
            },
          ],
        },
        { kind: 'text', text: 'Koniec.' },
      ];
};

/** Long background work with a marker the browser can count occurrences of. */
export const continuityScript = (prompt: string): Step[] =>
  prompt.includes('krotkie')
    ? [{ kind: 'text', text: 'Krotka odpowiedz.', delayMs: 100 }]
    : prompt.includes('nawigacja')
      ? [
          /*
           * Moves the screen **before** the network is lost, and keeps working
           * afterwards. What matters on the client's return is that the answer
           * arrives and the navigation does *not* happen a second time.
           */
          { kind: 'text', text: 'Otwieram pliki. ', delayMs: 150 },
          { kind: 'ui', targetId: 'platform.files', label: 'pliki' },
          { kind: 'wait', delayMs: 6000 },
          { kind: 'text', text: 'WYNIK-KONCOWY-A' },
        ]
      : [
        { kind: 'text', text: 'Zaczynam prace. ', delayMs: 200 },
        { kind: 'wait', delayMs: 6000 },
        { kind: 'text', text: 'WYNIK-KONCOWY-A' },
      ];

/** A run long enough for a hard timeout to end it without anyone pressing Stop. */
export const neverEndingScript = (): Step[] => [
  { kind: 'text', text: 'Zaczynam bardzo dluga prace. ', delayMs: 150 },
  { kind: 'idle', delayMs: 120_000 },
  { kind: 'text', text: 'NIE-POWINNO-DOJSC' },
];

/** A run that leaves a real child process behind while it works. */
export const childProcessScript = (): Step[] => [
  { kind: 'text', text: 'Uruchamiam obliczenia. ', delayMs: 150 },
  { kind: 'spawnChild' },
  { kind: 'idle', delayMs: 120_000 },
  { kind: 'text', text: 'NIE-POWINNO-DOJSC' },
];

/**
 * Files: attachments read from the workspace, a workbook processed and
 * published, and a corrupt one refused.
 */
export const filesScript = (prompt: string): Step[] => {
  if (prompt.includes('zalaczniki')) {
    return [
      { kind: 'text', text: 'Czytam zalaczone pliki. ', delayMs: 120 },
      { kind: 'workspaceScript', script: READ_INPUTS, maxChars: 1600 },
      { kind: 'text', text: ' Tyle udalo sie odczytac.' },
    ];
  }
  if (prompt.includes('uszkodzony')) {
    return [
      { kind: 'text', text: 'Probuje otworzyc skoroszyt. ', delayMs: 120 },
      { kind: 'ask', toolName: 'Bash', input: { command: 'node przetworz.mjs' }, then: [
        { kind: 'workspaceScript', script: OPEN_WORKBOOK, maxChars: 600 },
      ] },
      { kind: 'text', text: ' Nie zmyslam zawartosci.' },
    ];
  }
  /*
   * Two publication names, so a conversation that only wants to *look* at the
   * published artifact does not have to share a title with an earlier one — an
   * artifact browser listing two identically named entries cannot be clicked
   * unambiguously.
   */
  const publishedName = prompt.includes('artefakt') ? 'oferty-artefakt.xlsx' : 'oferty-poprawione.xlsx';
  return [
    { kind: 'text', text: 'Otwieram skoroszyt. ', delayMs: 120 },
    { kind: 'call', name: 'files_list', maxChars: 600 },
    {
      kind: 'ask',
      toolName: 'Bash',
      input: { command: 'node przetworz.mjs' },
      then: [
        { kind: 'workspaceScript', script: PROCESS_WORKBOOK, maxChars: 600 },
        {
          kind: 'call',
          name: 'files_publish_version',
          input: (calls: CallRecord[]) => ({
            path: 'oferty-poprawione.xlsx',
            originalFileId: attachedWorkbook(calls),
            filename: publishedName,
            operationId: `e2e-bl09-publikacja-${publishedName}`,
          }),
          maxChars: 500,
        },
      ],
    },
    { kind: 'text', text: ' Opublikowalem nowa wersje.' },
  ];
};
