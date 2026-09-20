#!/usr/bin/env node
/**
 * Drives one agent run over the real AG-UI endpoint and prints the event stream.
 *
 * Also answers permission requests, the way the chat panel's PermissionPrompt
 * does, so the sandbox scenarios can be exercised without a browser.
 *
 *   node scripts/run-agent.mjs "<prompt>" --case <id> --space <id> [--thread <id>]
 *                              [--deny] [--attach <fileId>]
 *
 * The run mutates whatever instance answers, so where it points is checked
 * before the first request rather than documented: see
 * `lib/acceptance-target.mjs` (L1.8).
 */
import { odciskZPrzenosnika, requireAcceptanceInstance, sprawdzOdciskPoswiadczen } from './lib/acceptance-target.mjs';

const args = process.argv.slice(2);
const prompt = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

if (!prompt) {
  console.error('usage: run-agent.mjs "<prompt>" --case <id> --space <id> [--thread <id>] [--deny] [--attach <fileId>]');
  process.exit(2);
}

/*
 * Before anything at all: not before the first *write*, but before the first
 * request. `/api/auth/session` below is a POST, and a POST to the user's
 * instance is already what this prevents.
 */
let BASE;
let odciskPoswiadczen;
try {
  const cel = await requireAcceptanceInstance(process.env);
  BASE = cel.base;
  odciskPoswiadczen = cel.odciskPoswiadczen;
} catch (e) {
  console.error(e.message);
  process.exit(3);
}
console.log(`# instancja: ${BASE}`);

const jar = [];
const fetchWithCookies = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(jar.length ? { cookie: jar.join('; ') } : {}) },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) jar.push(c.split(';')[0]);
  return res;
};

/*
 * ETAP 2, dziura 2: odcisk pliku poświadczeń brany przy bramce (w pamięci ORAZ
 * w pliku-przenośniku w test-results, jak w e2e/credential-guard.ts) i
 * porównywany przy KAŻDYM kończeniu — także przy nieprzechwyconym wyjątku w
 * trakcie biegu, bo „przebieg się wywalił" nie może być wymówką dla
 * naruszenia logowania. Zmiana odcisku kończy kodem 5 z nazwaniem przebiegu
 * sprawcą; krach bez naruszenia zachowuje kod 1 i stos wyjątku.
 */
let kodWyjscia = 0;
try {
  await fetchWithCookies(`${BASE}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: flag('user') ?? 'local-user' }),
  });

  const body = {
    threadId: flag('thread') ?? null,
    runId: crypto.randomUUID(),
    messages: [{ id: crypto.randomUUID(), role: 'user', content: prompt }],
    context: {
      conversationId: flag('thread') ?? null,
      spaceId: flag('space') ?? null,
      resource: flag('case') ? { kind: 'case', id: flag('case') } : null,
      selection: flag('select') ? [{ kind: flag('select-kind') ?? 'offer_item', id: flag('select') }] : [],
      filters: {},
      viewport: null,
      drafts: [],
    },
    forwardedProps: flag('attach') ? { attachFileIds: [flag('attach')] } : {},
  };

  const started = Date.now();
  const res = await fetchWithCookies(`${BASE}/api/agui/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });

  const runId = res.headers.get('x-run-id');
  const conversationId = res.headers.get('x-conversation-id');
  console.log(`# run=${runId} conversation=${conversationId}`);

  if (!res.ok || !res.body) {
    console.error('HTTP', res.status, await res.text());
    kodWyjscia = 1;
  } else {
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenAt = null;
    let text = '';
    const counts = {};

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        counts[event.type] = (counts[event.type] ?? 0) + 1;

        switch (event.type) {
          case 'TEXT_MESSAGE_CONTENT':
            if (firstTokenAt === null) firstTokenAt = Date.now() - started;
            text += event.delta;
            process.stdout.write(event.delta);
            break;
          case 'TOOL_CALL_START':
            process.stdout.write(`\n[TOOL] ${event.toolCallName}`);
            break;
          case 'TOOL_CALL_ARGS':
            process.stdout.write(` ${String(event.delta).slice(0, 220)}\n`);
            break;
          case 'TOOL_CALL_RESULT':
            process.stdout.write(`[RESULT] ${String(event.content).slice(0, 260)}\n`);
            break;
          case 'CUSTOM': {
            process.stdout.write(`\n[CUSTOM] ${event.name} ${JSON.stringify(event.value).slice(0, 200)}\n`);
            if (event.name === 'platform.permission_request') {
              const allow = !has('deny');
              process.stdout.write(`[ZGODA] odpowiadam: ${allow ? 'tak' : 'nie'}\n`);
              void fetchWithCookies(`${BASE}/api/runs/${event.value.runId}/permission`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requestId: event.value.requestId, allow }),
              });
            }
            break;
          }
          case 'RUN_ERROR':
            process.stdout.write(`\n[RUN_ERROR] ${event.code}: ${event.message}\n`);
            break;
          case 'RUN_FINISHED':
            process.stdout.write(`\n[RUN_FINISHED] ${event.durationMs} ms\n`);
            break;
          default:
            break;
        }
      }
    }

    console.log(`\n# events: ${JSON.stringify(counts)}`);
    console.log(`# first token: ${firstTokenAt ?? '-'} ms, total: ${Date.now() - started} ms`);
    console.log(`# conversation: ${conversationId}`);
  }
} catch (blad) {
  console.error(blad instanceof Error ? (blad.stack ?? blad.message) : String(blad));
  kodWyjscia = kodWyjscia || 1;
} finally {
  try {
    sprawdzOdciskPoswiadczen(odciskPoswiadczen ?? odciskZPrzenosnika());
  } catch (e) {
    console.error(e.message);
    process.exit(5);
  }
}
process.exit(kodWyjscia);
