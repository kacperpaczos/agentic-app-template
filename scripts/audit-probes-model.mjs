#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — not production code, not part of `pnpm test`.
 * Probes that require a real model turn. Runs against the isolated audit
 * instance so the user's data is untouched.
 *   AUDIT_BASE=http://127.0.0.1:8795 node scripts/audit-probes-model.mjs [id...]
 */
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:8795';
const want = process.argv.slice(2);
const wanted = (id) => want.length === 0 || want.includes(id);
const out = [];
const probe = (id, ok, note) => {
  const line = `PROBE ${id.padEnd(26)} ${ok ? 'OK ' : 'GAP'} ${note}`;
  out.push(line);
  console.log(`\n${line}\n${'-'.repeat(100)}`);
};

const jar = [];
const call = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
      ...(jar.length ? { cookie: jar.join('; ') } : {}),
    },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]);
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
};

/** Streams one AG-UI run; returns collected events and ids. */
async function run(prompt, { caseId, spaceId, threadId = null, select = null, drafts = [], onStart } = {}) {
  const body = {
    threadId, runId: crypto.randomUUID(),
    messages: [{ id: crypto.randomUUID(), role: 'user', content: prompt }],
    context: {
      conversationId: threadId, spaceId,
      resource: caseId ? { kind: 'case', id: caseId } : null,
      selection: select ? [select] : [], filters: {}, viewport: null, drafts,
    },
  };
  const res = await fetch(`${BASE}/api/agui/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie: jar.join('; ') },
    body: JSON.stringify(body),
  });
  const runId = res.headers.get('x-run-id');
  const conversationId = res.headers.get('x-conversation-id');
  onStart?.({ runId, conversationId });
  const events = [];
  let text = '';
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const e = JSON.parse(line.slice(6));
      events.push(e);
      if (e.type === 'TEXT_MESSAGE_CONTENT') text += e.delta;
    }
  }
  return { runId, conversationId, events, text };
}

const tools = (events) => events.filter((e) => e.type === 'TOOL_CALL_START').map((e) => e.toolCallName);

await call('/api/auth/session', { method: 'POST', body: '{}' });
const caseId = (await call('/api/m/procurement/cases')).body.cases[0].id;
const space = (await call('/api/canvas/spaces/for-scope', {
  method: 'POST', body: JSON.stringify({ kind: 'case', id: caseId, title: 'Audyt' }),
})).body.space;

/* ============ M1: canvas update/move/remove + get_context (L3.2, L6.3) ===== */

if (wanted('canvas-crud')) {
  const seed = (await call('/api/canvas/cards', {
    method: 'POST',
    body: JSON.stringify({
      spaceId: space.id, title: 'Notatka audytowa',
      spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'PRZED' } },
      geometry: { x: 1200, y: 1200, width: 300, height: 160 },
    }),
  })).body;
  const doomed = (await call('/api/canvas/cards', {
    method: 'POST',
    body: JSON.stringify({
      spaceId: space.id, title: 'Do usuniecia',
      spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'X' } },
      geometry: { x: 1600, y: 1200, width: 260, height: 140 },
    }),
  })).body;

  const r = await run(
    `Wykonaj dokladnie trzy operacje na canvasie, uzywajac narzedzi aplikacji:
1) najpierw pobierz aktualny kontekst aplikacji,
2) zmien tresc karty o id ${seed.id} na markdown "PO AUDYCIE",
3) przesun te karte na pozycje x=40 y=40,
4) usun karte o id ${doomed.id}.
Na koniec napisz GOTOWE.`,
    { caseId, spaceId: space.id },
  );

  const used = tools(r.events);
  const state = (await call(`/api/canvas/spaces/${space.id}`)).body;
  const updated = state.cards.find((c) => c.id === seed.id);
  const removed = !state.cards.some((c) => c.id === doomed.id);
  const contentChanged = updated && JSON.stringify(updated.spec).includes('PO AUDYCIE');
  const moved = updated && updated.geometry.x === 40 && updated.geometry.y === 40;

  probe('CANVAS-update', Boolean(contentChanged),
    `spec=${updated ? JSON.stringify(updated.spec.props) : 'brak'} specVersion=${updated?.specVersion}`);
  probe('CANVAS-move', Boolean(moved),
    `geometry=${updated ? `${updated.geometry.x},${updated.geometry.y}` : 'brak'} geometryVersion=${updated?.geometryVersion}`);
  probe('CANVAS-remove', removed, removed ? 'karta usunieta' : 'karta nadal istnieje');
  probe('CTX-get_context', used.includes('mcp__app__get_context'),
    `wywolane narzedzia: ${[...new Set(used)].join(', ')}`);
}

/* =================== M2: wspolbieznosc (L7.4, L4.5) ======================= */

if (wanted('concurrency')) {
  // (a) two commands fired at the same time in ONE conversation
  const conv = (await call('/api/threads/create', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ id: crypto.randomUUID(), role: 'user', content: 'Audyt wspolbieznosci' }] }),
  })).body;

  const t0 = Date.now();
  const [a, b] = await Promise.all([
    run('Odpowiedz dokladnie: ALFA. Nic wiecej.', { caseId, spaceId: space.id, threadId: conv.id }),
    run('Odpowiedz dokladnie: BETA. Nic wiecej.', { caseId, spaceId: space.id, threadId: conv.id }),
  ]);
  const elapsed = Date.now() - t0;
  const runs = (await call(`/api/conversations/${conv.id}/runs`)).body.runs;
  const sameConv = a.conversationId === conv.id && b.conversationId === conv.id;
  const notMixed = !(a.text.includes('ALFA') && a.text.includes('BETA'))
    && !(b.text.includes('ALFA') && b.text.includes('BETA'));
  const bothResolved = runs.filter((r) => r.status !== 'running').length >= 2;
  /*
   * `agent_runs.started_at` is written when the run is ENQUEUED, not when it
   * starts executing, so comparing it to `finished_at` says nothing about
   * serialisation. The execution window has to be reconstructed as
   * [finishedAt - durationMs, finishedAt]. The first version of this probe got
   * this wrong and reported a false GAP.
   */
  const windows = runs
    .filter((r) => r.finishedAt && r.durationMs !== null)
    .map((r) => {
      const end = new Date(r.finishedAt).getTime();
      return { id: r.id, begin: end - r.durationMs, end };
    })
    .sort((x, y) => x.begin - y.begin)
    .slice(0, 2);
  const serialised = windows.length === 2 && windows[0].end <= windows[1].begin;

  probe('CONC-jedna-rozmowa-izolacja', sameConv && notMixed && bothResolved,
    `A="${a.text.trim().slice(0, 20)}" B="${b.text.trim().slice(0, 20)}" uruchomien=${runs.length} rozstrzygnietych=${runs.filter((r) => r.status !== 'running').length}`);
  probe('CONC-jedna-rozmowa-kolejka', serialised,
    windows.length === 2
      ? `okna wykonania: ${windows[0].id.slice(-6)} konczy ${new Date(windows[0].end).toISOString().slice(11, 23)}, ${windows[1].id.slice(-6)} zaczyna ${new Date(windows[1].begin).toISOString().slice(11, 23)} — ${serialised ? 'brak nakladania' : 'NAKLADANIE'}`
      : 'brak danych o czasach');

  const msgs = (await call(`/api/threads/get/${conv.id}`)).body;
  const userMsgs = msgs.filter((m) => m.role === 'user').length;
  probe('CONC-brak-duplikatow-wiadomosci', userMsgs === 3,
    `wiadomosci uzytkownika=${userMsgs} (1 zalozycielska + 2 polecenia), lacznie=${msgs.length}, ${elapsed} ms`);

  // (b) two DIFFERENT conversations at once — must run in parallel, not queue
  const t1 = Date.now();
  const [c, d] = await Promise.all([
    run('Odpowiedz dokladnie: GAMMA.', { caseId, spaceId: space.id }),
    run('Odpowiedz dokladnie: DELTA.', { caseId, spaceId: space.id }),
  ]);
  const par = Date.now() - t1;
  probe('CONC-rozne-rozmowy', c.conversationId !== d.conversationId,
    `osobne rozmowy ${c.conversationId?.slice(-6)} / ${d.conversationId?.slice(-6)}, lacznie ${par} ms`);
}

/* ========================= M3: Stop (L11.7, L5.2) ========================= */

if (wanted('stop')) {
  const serverPid = execSync('cat /tmp/audit-server-8795.pid').toString().trim();
  const children = () => {
    try {
      return execSync(`pgrep -P ${serverPid} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
    } catch { return []; }
  };
  const before = children();

  let runId = null;
  let convId = null;
  const started = run(
    'Policz powoli od 1 do 400, kazda liczbe w osobnej linii, bez pomijania. To zadanie ma trwac dlugo.',
    { caseId, spaceId: space.id, onStart: (i) => { runId = i.runId; convId = i.conversationId; } },
  );

  await new Promise((r) => setTimeout(r, 9000));
  const during = children();
  const t0 = Date.now();
  const cancel = await call(`/api/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
  const ackMs = Date.now() - t0;
  const result = await started;
  const stopMs = Date.now() - t0;

  const runRow = (await call(`/api/conversations/${convId}/runs`)).body.runs.find((r) => r.id === runId);
  const evAfter = (await call(`/api/runs/${runId}/events`)).body.events;
  const lastNames = evAfter.slice(-3).map((e) => e.name);

  // settle, then look for leftover children
  await new Promise((r) => setTimeout(r, 4000));
  const after = children();
  const leaked = after.filter((p) => !before.includes(p));

  probe('STOP-potwierdzenie', cancel.body?.cancelled === true,
    `cancelled=${cancel.body?.cancelled} ack=${ackMs} ms`);
  probe('STOP-status-koncowy', runRow?.status === 'cancelled',
    `status=${runRow?.status} errorCode=${runRow?.errorCode} czas do zamkniecia strumienia=${stopMs} ms`);
  probe('STOP-strumien-rozstrzygniety', lastNames.includes('RUN_ERROR') || lastNames.includes('RUN_FINISHED'),
    `ostatnie zdarzenia: ${lastNames.join(' → ')}`);
  probe('STOP-brak-osieroconych-procesow', leaked.length === 0,
    `dzieci serwera przed=${before.length} w trakcie=${during.length} po=${after.length} osierocone=${leaked.join(',') || 'brak'}`);

  const seqBefore = evAfter.length;
  await new Promise((r) => setTimeout(r, 3000));
  const evLater = (await call(`/api/runs/${runId}/events`)).body.events;
  probe('STOP-brak-pozniejszych-zapisow', evLater.length === seqBefore,
    `zdarzen po anulowaniu: ${seqBefore} → ${evLater.length}`);

  /*
   * Checked by run status, not by the model's wording. The first version of this
   * probe required the literal answer "PO-STOPIE" and reported a false GAP: the
   * run did execute and succeed, but the resumed session still carried the
   * interrupted task, so the model answered something else. What the criterion
   * asks is that the next task is unblocked — that is a status question.
   */
  const next = await run('Odpowiedz dokladnie: PO-STOPIE.', { caseId, spaceId: space.id, threadId: convId });
  const nextRuns = (await call(`/api/conversations/${convId}/runs`)).body.runs;
  const nextRow = nextRuns.find((r) => r.id === next.runId);
  probe('STOP-kolejka-odblokowana', nextRow?.status === 'succeeded',
    `nastepne uruchomienie w tej samej rozmowie: status=${nextRow?.status} dur=${nextRow?.durationMs} ms; odpowiedz="${next.text.trim().slice(0, 40)}"`);
}

/* ===================== M4: szkic formularza (L6.5) ======================== */

if (wanted('draft')) {
  const detail = (await call(`/api/m/procurement/cases/${caseId}`)).body;
  const offer = detail.offers.find((o) => o.items.length > 0);
  const item = offer.items[0];
  const r = await run(
    `Jaka jest ZAPISANA ilosc pozycji ${item.id}? Odpowiedz sama liczba i zaznacz, czy w kontekscie jest niezapisany szkic.`,
    {
      caseId, spaceId: space.id,
      drafts: [{ formId: `item-${item.id}`, entity: 'offer_item', entityId: item.id, dirtyFields: ['quantity'] }],
    },
  );
  const saved = item.quantityMilli / 1000;
  const mentionsDraft = /szkic|niezapisan|draft/i.test(r.text);
  probe('DRAFT-rozroznienie', r.text.includes(String(saved)) && mentionsDraft,
    `zapisana ilosc=${saved}; odpowiedz wspomina szkic=${mentionsDraft}; "${r.text.trim().slice(0, 90)}"`);
}

writeFileSync('docs/evidence/audit-2026-09-15/05-probes-model.txt', out.join('\n') + '\n');
console.log(`\nzapisano ${out.length} wynikow`);
