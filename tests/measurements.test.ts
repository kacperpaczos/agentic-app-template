import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, collectToolEntries, platformTools } from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';
import {
  dispatchingAgent,
  newStandInHandle,
  type Plan,
  type StandInHandle,
  type Step,
} from './support/model-standin.ts';
import {
  CODE_COMMIT_ENV,
  CODE_TREE_DIRTY_ENV,
  EVIDENCE_DIR,
  codeVersion,
  evidenceWritingRequested,
  writeMeasurementRecord,
  type Measurement,
} from './support/measurement-evidence.ts';

/**
 * The template's own measurement regression.
 *
 * Every number the acceptance report quotes for BL-05 is produced here or in
 * `e2e/measurements.spec.ts`, by `pnpm test` / `pnpm test:e2e`, and written to
 * `docs/evidence/z3-bl05/` with its conditions and the commit it came from. A
 * number pasted into a report by hand is not a measurement; a number without
 * the interval it spans is not one either.
 *
 * **These are simulations of the model, and are marked as such.** The model is
 * replaced at the adapter boundary (`ModelAgentLike`) by a stand-in that
 * receives the very `sdkOptions` and `AbortSignal` the Claude Agent SDK would.
 * Everything else — the conversation queue, the run registry, the event stream,
 * the projection, the workspace, the MCP tool handlers, the HTTP cancel route —
 * is the real thing. The orderings that matter here (an answer with no text at
 * all; a stop landing mid-stream) are chosen by the model, not by the caller,
 * which is exactly why they are scripted rather than prompted.
 *
 * What the stand-in cannot stand in for is stated wherever it matters: the
 * Claude Agent SDK's own child process is not started, so the child this run
 * kills is one the stand-in spawned at the same boundary the SDK sits at.
 */

/* --------------------------------- harness -------------------------------- */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
const openHandles: StandInHandle[] = [];
const pending: Array<Promise<unknown>> = [];
let promptSeq = 0;

const EMPTY_CONTEXT = {
  conversationId: null as string | null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

/** Starts one run against the shared runtime and returns everything measurable. */
async function startRun(conversationId: string, script: Step[]) {
  promptSeq += 1;
  const prompt = `polecenie pomiarowe ${promptSeq}`;
  const handle: StandInHandle = newStandInHandle();
  plans.set(prompt, { script, handle });
  openHandles.push(handle);

  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  let streamEndedAt: number | null = null;
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
    streamEndedAt = Date.now();
  })();
  pending.push(started.done.catch(() => undefined), reader);
  return {
    stand: handle,
    runId: started.runId,
    stream: started.stream,
    done: started.done,
    reader,
    events,
    get streamEndedAt() {
      return streamEndedAt;
    },
    run: () => h.platform.services.runs.get(started.runId, h.ownerId),
    workspaceDir: resolve(h.platform.config.workspacesDir, started.runId),
  };
}

const newConversation = () =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'Pomiar' }).id;

const waitUntil = async (predicate: () => boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('warunek nie zaszedl w czasie');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  h = await createHarness();
  plans = new Map();
  runtime = new AgentRuntime(
    h.platform.services,
    dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  );
});
afterEach(async () => {
  // Nothing may still be writing when the database closes — including the runs
  // a failed assertion left in flight.
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  for (const s of openHandles.splice(0)) s.dispose();
  h.dispose();
});

/* ------------------------------ the measurements -------------------------- */

/**
 * Slack for a comparison that spans two clocks (see its use below).
 *
 * Kept far under the 120 ms this measurement partitions, so widening it cannot
 * hide the regression it exists to catch — a `durationMs` measured from the
 * moment the run was accepted instead of from the moment it began overshoots by
 * the whole queue wait, which this window is nowhere near.
 */
const SEAM_MS = 25;

const SAMPLES = 5;
const TEXT_SCRIPT: Step[] = [
  { kind: 'wait', ms: 15 },
  { kind: 'text', text: 'Pierwszy fragment. ', delayMs: 10 },
  { kind: 'text', text: 'Drugi fragment. ', delayMs: 10 },
  { kind: 'text', text: 'Trzeci fragment.', delayMs: 10 },
];

describe('pomiary rozdzielone na punkty, zapisane z warunkami i wersja kodu', () => {
  it('kolejka, start wykonania, pierwszy tekst i zakonczenie sa osobnymi punktami; brak tekstu daje brak metryki', async () => {
    const czasKolejki: Array<number | null> = [];
    const doPierwszegoTekstu: Array<number | null> = [];
    const czasWykonania: Array<number | null> = [];

    /* --- runs that had nothing ahead of them ------------------------------ */
    for (let i = 0; i < SAMPLES; i += 1) {
      const r = await startRun(newConversation(), TEXT_SCRIPT);
      await r.done;
      await r.reader;
      const run = r.run();
      expect(run.status).toBe('succeeded');
      czasKolejki.push(run.queuedMs);
      doPierwszegoTekstu.push(run.firstTokenMs);
      czasWykonania.push(run.durationMs);

      // The four instants are stored separately and in order.
      expect(Date.parse(run.startedAt)).toBeGreaterThanOrEqual(Date.parse(run.enqueuedAt));
      expect(Date.parse(run.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
      expect(run.firstTokenMs!).toBeLessThanOrEqual(run.durationMs!);
    }

    /* --- a run that waited behind another, in the same conversation -------- */
    const czasKolejkiZaInnym: Array<number | null> = [];
    for (let i = 0; i < 3; i += 1) {
      const conversationId = newConversation();
      const first = await startRun(conversationId, [
        { kind: 'wait', ms: 120 },
        { kind: 'text', text: 'pierwsze' },
      ]);
      const second = await startRun(conversationId, TEXT_SCRIPT);
      await Promise.all([first.done, second.done, first.reader, second.reader]);
      const s = second.run();
      czasKolejkiZaInnym.push(s.queuedMs);
      /*
       * The wait belongs to the queue, not to the model. Asserted as a
       * partition rather than as a threshold: queue time plus execution time
       * accounts for the whole span from enqueue to finish, so the 120 ms spent
       * behind the first run is counted once, on the queue side — which is what
       * a threshold in milliseconds would only suggest, and only on one machine.
       *
       * The tolerance is `SEAM_MS`, and it is not a fudge factor: the two sides
       * of the comparison are read from two different clocks. `queuedMs` and
       * `total` are differences of *stored* instants (`nowIso()`), while
       * `durationMs` is a difference of `Date.now()` taken inside the run — and
       * each stored instant is written a moment after its `Date.now()`
       * counterpart, with a statement preparation in between. The seam is
       * therefore whatever the process can be descheduled for at those two
       * points, and a run of this suite under load produced 268 against a
       * ±5 ms window. The window says nothing about the property; what tests
       * the property is that it is an order of magnitude below the 120 ms
       * being partitioned.
       */
      const total = Date.parse(s.finishedAt!) - Date.parse(s.enqueuedAt);
      expect(s.queuedMs).toBeGreaterThan(50);
      expect(s.queuedMs! + s.durationMs!).toBeLessThanOrEqual(total + SEAM_MS);
      expect(s.queuedMs! + s.durationMs!).toBeGreaterThanOrEqual(total - SEAM_MS);
    }

    /* --- a run that says nothing at all ----------------------------------- */
    const silent = await startRun(newConversation(), [
      { kind: 'call', name: 'canvas_catalog' },
      { kind: 'wait', ms: 20 },
    ]);
    await silent.done;
    await silent.reader;
    const silentRun = silent.run();
    expect(silentRun.status).toBe('succeeded');
    expect(silent.stand.performed).toEqual(['canvas_catalog']);
    // The load-bearing distinction of L12.13: the metric is absent, not zero.
    expect(silentRun.firstTokenMs).toBeNull();
    expect(silentRun.firstTokenMs).not.toBe(0);
    expect(silentRun.durationMs).toBeGreaterThanOrEqual(0);
    // It did real work, so "nothing happened" is not an explanation either.
    expect(silent.events.some((e) => e.type === 'TOOL_CALL_RESULT')).toBe(true);
    expect(silent.events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toBe(false);
    doPierwszegoTekstu.push(silentRun.firstTokenMs);
    czasWykonania.push(silentRun.durationMs);

    const pomiary: Record<string, Measurement> = {
      czasKolejki: {
        co: 'czas oczekiwania uruchomienia w kolejce rozmowy, gdy nic go nie poprzedza',
        od: 'zakolejkowanie uruchomienia (agent_runs.enqueued_at)',
        do: 'start wykonania (agent_runs.started_at)',
        warunki: `stand-in modelu na granicy adaptera; ${SAMPLES} uruchomien, kazde we wlasnej rozmowie; baza tymczasowa`,
        probkiMs: czasKolejki,
      },
      czasKolejkiZaInnymUruchomieniem: {
        co: 'czas oczekiwania uruchomienia, przed ktorym w tej samej rozmowie trwa inne',
        od: 'zakolejkowanie uruchomienia',
        do: 'start wykonania, po zwolnieniu kolejki rozmowy',
        warunki:
          'stand-in modelu; 3 pary uruchomien w jednej rozmowie, pierwsze zajmuje ok. 120 ms; ' +
          'czas wykonania drugiego nie zawiera tego oczekiwania',
        probkiMs: czasKolejkiZaInnym,
      },
      czasDoPierwszegoTekstu: {
        co: 'czas do pierwszego przyrostu tekstu odpowiedzi',
        od: 'start wykonania',
        do: 'pierwszy niepusty przyrost tekstu ze strumienia modelu',
        warunki:
          `stand-in modelu; ${SAMPLES} uruchomien z tekstem i 1 uruchomienie bez tekstu ` +
          '(wywolanie narzedzia, zadnego slowa). Skrypt odpowiedzi czeka 15 ms przed pierwszym ' +
          'przyrostem i opoznia sam przyrost o 10 ms, wiec ok. 25 z mierzonych milisekund to ' +
          'wymuszony sen stand-ina, nie czas modelu — ta liczba mowi o rozdzieleniu punktu ' +
          'pomiaru, nie o szybkosci odpowiadania.',
        probkiMs: doPierwszegoTekstu,
        uwagi:
          'Ostatnia probka to null: uruchomienie bez tekstu nie ma czasu pierwszego tekstu. ' +
          'Null jest wynikiem, nie brakiem danych, i nie jest zerem — zero znaczyloby „natychmiast”.',
      },
      czasWykonania: {
        co: 'czas wykonania uruchomienia',
        od: 'start wykonania',
        do: 'zapisany status koncowy uruchomienia',
        warunki: `stand-in modelu; ${SAMPLES} uruchomien z tekstem i 1 bez tekstu; skrypt odpowiedzi ma ok. 45 ms wymuszonych opoznien`,
        probkiMs: czasWykonania,
      },
    };

    const record = writeMeasurementRecord('pomiary-backend-runda3.json', {
      opis:
        'Punkty pomiaru uruchomienia agenta rozdzielone: kolejka, start wykonania, pierwszy tekst, ' +
        'zakonczenie. Brak tekstu daje brak metryki, nie zero.',
      zrodlo: 'pnpm test → tests/measurements.test.ts (regresja szablonu)',
      rodzajWykonania: 'symulacja',
      wersjaKodu: codeVersion(h.platform.versions),
      pomiary,
    });

    /*
     * The serialised record is part of the assertion: a `null` that becomes a
     * `0` on the way to the file would undo the distinction the test just
     * proved. Asserted on the bytes a write *would* produce, not on the file,
     * so this check runs on an ordinary `pnpm verify` too — where nothing is
     * written at all (see `evidenceWritingRequested`).
     */
    const written = JSON.parse(record.body);
    const probki = written.pomiary.czasDoPierwszegoTekstu.probkiMs as Array<number | null>;
    expect(probki.at(-1)).toBeNull();
    expect(written.pomiary.czasDoPierwszegoTekstu.podsumowanie.brakMetryki).toBe(1);
    expect(written.pomiary.czasDoPierwszegoTekstu.podsumowanie.zMetryka).toBe(SAMPLES);
    expect(written.wersjaKodu.commit).toMatch(/^[0-9a-f]{7,40}$/);
    /*
     * The condition of measurement has to be a fact or an explicit blank.
     * This run happens inside the repository, so git can answer and the record
     * must carry a decided answer — `null` here would mean the measurement was
     * taken without knowing what it was taken on, which is a different (and
     * reportable) situation, not an acceptable alternative.
     */
    expect([true, false, null]).toContain(written.wersjaKodu.brudneDrzewo);
    expect(
      written.wersjaKodu.brudneDrzewo,
      'stan drzewa musi byc ustalony — z gita albo z deklaracji kopii bez gita',
    ).not.toBeNull();
    expect(record.path).toContain(EVIDENCE_DIR);
    // The switch decides the write, and nothing else does.
    expect(record.written).toBe(evidenceWritingRequested());
  });
});

/* --------------------- the conditions of a measurement --------------------- */

describe('warunek pomiaru jest faktem albo jawnym brakiem, nigdy domyslnie korzystny', () => {
  const cwd = process.cwd();
  const saved = { commit: process.env[CODE_COMMIT_ENV], dirty: process.env[CODE_TREE_DIRTY_ENV] };
  afterEach(() => {
    process.chdir(cwd);
    for (const [key, value] of [
      [CODE_COMMIT_ENV, saved.commit],
      [CODE_TREE_DIRTY_ENV, saved.dirty],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('bez gita i bez deklaracji stan drzewa jest nieustalony, a nie czysty', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agentic-bez-gita-'));
    try {
      process.chdir(outside);
      delete process.env[CODE_TREE_DIRTY_ENV];
      const v = codeVersion();
      /*
       * The case this test exists for. `false` would read as "checked, and the
       * tree was clean" — a statement nobody was in a position to make. The
       * honest answer is that the question could not be asked.
       */
      expect(v.brudneDrzewo).toBeNull();
      expect(v.brudneDrzewo).not.toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('deklaracja liczy sie tylko wtedy, gdy git milczy, i tylko gdy cos mowi', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agentic-bez-gita-'));
    try {
      process.chdir(outside);
      process.env[CODE_TREE_DIRTY_ENV] = '1';
      expect(codeVersion().brudneDrzewo).toBe(true);
      process.env[CODE_TREE_DIRTY_ENV] = '0';
      expect(codeVersion().brudneDrzewo).toBe(false);
      // Anything that is not a statement leaves the question open rather than
      // closing it in the convenient direction.
      process.env[CODE_TREE_DIRTY_ENV] = 'moze';
      expect(codeVersion().brudneDrzewo).toBeNull();
      process.env[CODE_TREE_DIRTY_ENV] = '';
      expect(codeVersion().brudneDrzewo).toBeNull();
    } finally {
      process.chdir(cwd);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('git wygrywa z deklaracja wszedzie tam, gdzie git moze odpowiedziec', () => {
    /*
     * Runs in two worlds: this repository (`pnpm verify`) and the copy without
     * `.git` that `pnpm check:module-swap` builds. The rule is one, so it is
     * written here whole and each world checks its own half — instead of the
     * test assuming git is always there, which is the very assumption that made
     * this field lie in the first place. The first draft of this test did assume
     * it, and the copy failed it.
     */
    let gitAnswers = true;
    try {
      execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      gitAnswers = false;
    }

    if (gitAnswers) {
      const real = codeVersion().brudneDrzewo;
      expect(typeof real).toBe('boolean');
      // A caller claiming the opposite must not be heard.
      process.env[CODE_TREE_DIRTY_ENV] = real === true ? '0' : '1';
      expect(codeVersion().brudneDrzewo, 'deklaracja przebila gita').toBe(real);
      return;
    }

    // Without git the declaration is the only source — heard when it says
    // something, and unable to invent an answer when it does not.
    process.env[CODE_TREE_DIRTY_ENV] = '1';
    expect(codeVersion().brudneDrzewo).toBe(true);
    process.env[CODE_TREE_DIRTY_ENV] = '0';
    expect(codeVersion().brudneDrzewo).toBe(false);
    delete process.env[CODE_TREE_DIRTY_ENV];
    expect(codeVersion().brudneDrzewo).toBeNull();
  });
});

/* ----------------------------------- Stop --------------------------------- */

describe('Stop: rozdzielone potwierdzenie zadania, koniec strumienia i koniec procesow', () => {
  it('trzy instanty sa osobne, po zakonczeniu nie ma dalszych mutacji, a kolejka dziala', async () => {
    const cookie = await login(h.platform.app, h.ownerId);
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const criteriaBefore = JSON.stringify(h.service.getCaseDetail(caseId, h.ownerId).criteria);

    const doPotwierdzenia: Array<number | null> = [];
    const doKoncaStrumienia: Array<number | null> = [];
    const doKoncaProcesow: Array<number | null> = [];
    const doWyjsciaProcesuPotomnego: Array<number | null> = [];
    const stanyPoAnulowaniu: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const conversationId = newConversation();
      /*
       * A run that is streaming, holds a child process, and — if it were left
       * alone — would go on to change domain data. The mutation after the wait
       * is the point: "no further mutations after the end" has to be a claim
       * that could fail.
       */
      const r = await startRun(conversationId, [
        { kind: 'spawnChild' },
        { kind: 'text', text: 'Zaczynam dluga odpowiedz. ', delayMs: 10 },
        ...Array.from({ length: 20 }, (_, k) => ({
          kind: 'text' as const,
          text: `fragment ${k + 1} `,
          delayMs: 40,
        })),
        {
          kind: 'call',
          name: 'procurement_set_criteria_weights',
          input: { caseId, weights: [{ key: 'total_cost', weight: 99 }] },
        },
        { kind: 'text', text: 'Zmienilem wagi.' },
      ]);

      // A queued follower, so the queue after Stop is exercised rather than
      // asserted: it was accepted while the cancelled run still held the slot.
      const follower = await startRun(conversationId, TEXT_SCRIPT);
      expect(follower.run().status).toBe('queued');

      // Cancel real work, not a run that has not started speaking yet.
      await waitUntil(() => r.events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT'));
      expect(r.run().status).toBe('running');
      expect(r.stand.childPid).toBeTruthy();
      expect(existsSync(r.workspaceDir)).toBe(true);

      /* ----------------------------- measurement --------------------------- */

      const t0 = Date.now();
      const res = await h.platform.app.request(`/api/runs/${r.runId}/cancel`, {
        method: 'POST',
        headers: { cookie },
      });
      const acknowledgedAt = Date.now();
      /*
       * Read in the same synchronous step as the instant itself. Asserting it
       * after the `await` below would be asking about a moment several
       * macrotasks later — the answer would usually still be right, and the
       * measurement would no longer be about the instant it names.
       */
      const childExitedAtAck = r.stand.childExitedAt;
      expect(res.status).toBe(200);
      expect((await res.json()).cancelled).toBe(true);

      /*
       * The separation, asserted rather than assumed.
       *
       * Acknowledging the request is not the end of anything: at this instant
       * the process the run holds is still alive — the signal has been sent and
       * the operating system has not yet delivered its exit. That is precisely
       * why one number cannot answer "has the Stop taken effect": it would have
       * to mean either "the backend heard you" or "the work has stopped", and
       * those are different times.
       */
      expect(childExitedAtAck).toBeNull();

      await r.done;
      await r.reader;
      /*
       * "The run's processes ended" is the last of four facts, not the first:
       * the execution promise settled, the workspace is gone, the child process
       * exited and the live stream is deregistered. Reporting the promise alone
       * would report a number that is true before the work has stopped.
       */
      await waitUntil(() => r.stand.childExitedAt !== null);
      const processesEndedAt = Date.now();
      expect(existsSync(r.workspaceDir)).toBe(false);
      expect(runtime.liveStream(r.runId)).toBeNull();

      doPotwierdzenia.push(acknowledgedAt - t0);
      doKoncaStrumienia.push(r.streamEndedAt! - t0);
      doKoncaProcesow.push(processesEndedAt - t0);
      doWyjsciaProcesuPotomnego.push(r.stand.childExitedAt! - t0);

      const cancelled = r.run();
      stanyPoAnulowaniu.push(cancelled.status);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.errorCode).toBe('cancelled');
      expect(cancelled.finishedAt).not.toBeNull();

      // Order of the four instants. The gaps are small on a stand-in and are
      // dominated by the model process on a real run; what must hold on any
      // machine is that they are recorded apart and never out of order.
      expect(acknowledgedAt).toBeLessThanOrEqual(r.streamEndedAt!);
      expect(r.streamEndedAt!).toBeLessThanOrEqual(processesEndedAt);
      expect(r.stand.childExitedAt!).toBeLessThanOrEqual(processesEndedAt);
      // The gap that is a real interval and not a rounding artefact: the
      // acknowledgement precedes the death of the process the run was holding.
      // Its size is an operating-system detail; its sign is not.
      expect(acknowledgedAt).toBeLessThanOrEqual(r.stand.childExitedAt!);

      /* --------------------- no further mutations -------------------------- */

      /*
       * Counted per run, not per conversation. The conversation keeps growing
       * on purpose — the follower run is executing in it — so a count of all
       * its messages can only ever go up, and comparing it with `>=` asks a
       * question that has no failing answer. What must not grow is what the
       * *cancelled* run wrote.
       */
      const messagesOfCancelledRun = () =>
        h.platform.services.conversations
          .messages(conversationId, h.ownerId)
          .filter((m) => (m.meta as { runId?: string } | null)?.runId === r.runId).length;
      const eventsAfterEnd = h.platform.services.runs.events(r.runId, h.ownerId).length;
      const messagesAfterEnd = messagesOfCancelledRun();
      expect(messagesAfterEnd, 'anulowane uruchomienie nie zapisalo nic').toBeGreaterThan(0);
      // Long enough that the cancelled script's remaining steps would have run.
      await new Promise((rs) => setTimeout(rs, 400));
      expect(h.platform.services.runs.events(r.runId, h.ownerId).length).toBe(eventsAfterEnd);
      expect(messagesOfCancelledRun()).toBe(messagesAfterEnd);
      // The domain is the real test: the cancelled script's next step was a write.
      expect(r.stand.performed).not.toContain('procurement_set_criteria_weights');
      expect(JSON.stringify(h.service.getCaseDetail(caseId, h.ownerId).criteria)).toBe(
        criteriaBefore,
      );
      expect(h.platform.services.runs.events(r.runId, h.ownerId).some((e) => e.name === 'CUSTOM' &&
        (e.payload as any)?.name === 'platform.data_changed')).toBe(false);

      /* ------------------------ the queue still works ---------------------- */

      await follower.done;
      await follower.reader;
      expect(follower.run().status).toBe('succeeded');
      expect(follower.run().firstTokenMs).toBeGreaterThan(0);

      // And a command sent after the Stop, in the same conversation, runs too.
      const afterwards = await startRun(conversationId, TEXT_SCRIPT);
      await afterwards.done;
      await afterwards.reader;
      expect(afterwards.run().status).toBe('succeeded');
    }

    expect(stanyPoAnulowaniu).toEqual(['cancelled', 'cancelled', 'cancelled']);

    const warunki =
      'stand-in modelu na granicy adaptera (AbortSignal przekazany tak jak do Claude Agent SDK); ' +
      'zadanie Stop przez rzeczywista trase POST /api/runs/:id/cancel; 3 uruchomienia, kazde ' +
      'strumieniujace tekst i trzymajace prawdziwy proces potomny zwiazany z sygnalem przerwania; ' +
      'proces potomny zastepuje proces Claude Agent SDK, ktorego ten przebieg nie uruchamia';

    const stopRecord = writeMeasurementRecord('pomiary-stop-runda3.json', {
      opis:
        'Faktyczne anulowanie rozdzielone na trzy instanty: potwierdzenie zadania Stop, ' +
        'zakonczenie strumienia zdarzen i zakonczenie procesow uruchomienia. Po zakonczeniu ' +
        'sprawdzony brak dalszych mutacji domeny i dzialajaca kolejka rozmowy.',
      zrodlo: 'pnpm test → tests/measurements.test.ts (regresja szablonu)',
      rodzajWykonania: 'symulacja',
      wersjaKodu: codeVersion(h.platform.versions),
      pomiary: {
        stopPotwierdzenieZadania: {
          co: 'potwierdzenie zadania Stop przez backend',
          od: 'wyslanie POST /api/runs/:id/cancel',
          do: 'odpowiedz 200 z cancelled=true',
          warunki: `${warunki}; w tym instancie proces trzymany przez uruchomienie jeszcze zyje — asertowane, nie zalozone`,
          probkiMs: doPotwierdzenia,
        },
        stopKoniecStrumienia: {
          co: 'zakonczenie strumienia zdarzen anulowanego uruchomienia',
          od: 'wyslanie POST /api/runs/:id/cancel',
          do: 'wyczerpanie strumienia AG-UI po jego zamknieciu (koniec odczytu konsumenta)',
          warunki,
          probkiMs: doKoncaStrumienia,
        },
        stopKoniecProcesow: {
          co: 'zakonczenie procesow uruchomienia',
          od: 'wyslanie POST /api/runs/:id/cancel',
          do:
            'ostatni z czterech faktow: rozstrzygnieta obietnica wykonania, usuniety workspace, ' +
            'zakonczony proces potomny i wyrejestrowany strumien uruchomienia',
          warunki,
          probkiMs: doKoncaProcesow,
        },
        stopWyjscieProcesuPotomnego: {
          co: 'wyjscie procesu potomnego zwiazanego z sygnalem przerwania uruchomienia',
          od: 'wyslanie POST /api/runs/:id/cancel',
          do: 'zdarzenie exit procesu potomnego',
          warunki: `${warunki}; symulacja procesu potomnego modelu`,
          probkiMs: doWyjsciaProcesuPotomnego,
          uwagi:
            'Proces potomny jest stand-inem procesu Claude Agent SDK. Dowodzi, ze sygnal ' +
            'przerwania dociera na granice adaptera i konczy proces przed zamknieciem ' +
            'uruchomienia; nie dowodzi zachowania samego SDK.',
        },
      },
    });

    const written = JSON.parse(stopRecord.body);
    expect(stopRecord.written).toBe(evidenceWritingRequested());
    for (const key of ['stopPotwierdzenieZadania', 'stopKoniecStrumienia', 'stopKoniecProcesow']) {
      expect(written.pomiary[key].podsumowanie.zMetryka).toBe(3);
      expect(written.pomiary[key].podsumowanie.brakMetryki).toBe(0);
    }
  });
});
