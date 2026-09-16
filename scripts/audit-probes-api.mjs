#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — not production code, not part of `pnpm test`.
 * Probes the running audit instance over HTTP. Needs no model.
 *   AUDIT_BASE=http://127.0.0.1:8795 node scripts/audit-probes-api.mjs
 */
const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:8795';
const out = [];
const probe = (id, ok, note) => {
  const line = `PROBE ${id.padEnd(26)} ${ok ? 'OK ' : 'GAP'} ${note}`;
  out.push(line);
  console.log(line);
};

const session = () => {
  const jar = [];
  return {
    jar,
    async call(path, init = {}) {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
          ...(jar.length ? { cookie: jar.join('; ') } : {}),
        },
      });
      for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]);
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    },
  };
};

const A = session();
const B = session();
await A.call('/api/auth/session', { method: 'POST', body: JSON.stringify({ userId: 'local-user' }) });
await B.call('/api/auth/session', { method: 'POST', body: JSON.stringify({ userId: 'other-user' }) });

/* --------------------------- izolacja wlascicieli -------------------------- */

const space = (await A.call('/api/canvas/spaces', {
  method: 'POST', body: JSON.stringify({ title: 'Audyt izolacja' }),
})).body;
const card = (await A.call('/api/canvas/cards', {
  method: 'POST',
  body: JSON.stringify({
    spaceId: space.id, title: 'K',
    spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'tajne' } },
  }),
})).body;
const cases = (await A.call('/api/m/procurement/cases')).body.cases;
const art = (await A.call('/api/artifacts')).body;

const crossChecks = [
  ['canvas-space', `/api/canvas/spaces/${space.id}`],
  ['module-case', `/api/m/procurement/cases/${cases[0].id}`],
  ['module-comparison', `/api/m/procurement/cases/${cases[0].id}/comparison`],
];
let allDenied = true;
const details = [];
for (const [name, path] of crossChecks) {
  const r = await B.call(path);
  const denied = r.status === 403 || r.status === 404;
  if (!denied) allDenied = false;
  details.push(`${name}=${r.status}`);
}
probe('OWNER-cross-read', allDenied, details.join(' '));

const bList = (await B.call('/api/canvas/spaces')).body.spaces ?? [];
probe('OWNER-listy-rozlaczne', !bList.some((s) => s.id === space.id),
  `B widzi ${bList.length} przestrzeni, brak przestrzeni A`);

const bFiles = (await B.call('/api/files')).body.files ?? [];
const aFiles = (await A.call('/api/files')).body.files ?? [];
probe('OWNER-pliki-rozlaczne', bFiles.length === 0 && aFiles.length > 0,
  `A=${aFiles.length} plikow, B=${bFiles.length}`);

const bArt = (await B.call('/api/artifacts')).body.artifacts ?? [];
probe('OWNER-artefakty-rozlaczne', bArt.length === 0,
  `A=${(art.artifacts ?? []).length}, B=${bArt.length}`);

/* ------------------------------ artefakt live ------------------------------ */

const live = (await A.call('/api/artifacts', { method: 'GET' })).body;
const created = await A.call('/api/canvas/spaces', { method: 'POST', body: JSON.stringify({ title: 'tmp' }) });
void created; void live;

// Create a live artifact directly through the platform tool surface is not
// exposed over HTTP, so use the artifact endpoints the renderer uses.
const caseId = cases[0].id;
const cmpBefore = (await A.call(`/api/m/procurement/cases/${caseId}/comparison`)).body;
const firstOffer = cmpBefore.rows[0];

/* --------------------- idempotencja przy rownoleglosci --------------------- */

const detail = (await A.call(`/api/m/procurement/cases/${caseId}`)).body;
const offer = detail.offers.find((o) => o.items.length > 0);
const item = offer.items[0];
const op = `audit-parallel-${Date.now()}`;
const results = await Promise.all(
  Array.from({ length: 8 }, () =>
    A.call(`/api/m/procurement/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 5, operationId: op, expectedVersion: item.version }),
    })),
);
const okCount = results.filter((r) => r.status === 200).length;
const after = (await A.call(`/api/m/procurement/offers/${offer.offer.id}`)).body
  .items.find((i) => i.id === item.id);
const bumped = after.version - item.version;
probe('IDEMPOTENCY-8-rownoleglych', bumped === 1,
  `8 zadan z tym samym operationId: ${okCount} odpowiedzi 200, wersja pozycji ${item.version}→${after.version} (przyrost ${bumped}), ilosc=${after.quantityMilli / 1000}`);

/* ----------------------- konflikt wersji (bez operationId) ----------------- */

const cur = (await A.call(`/api/m/procurement/offers/${offer.offer.id}`)).body
  .items.find((i) => i.id === item.id);
const conflict = await A.call(`/api/m/procurement/items/${item.id}`, {
  method: 'PATCH', body: JSON.stringify({ quantity: 9, expectedVersion: cur.version - 1 }),
});
probe('CONFLICT-nieaktualna-wersja', conflict.status === 409,
  `status=${conflict.status} code=${conflict.body?.error?.code}`);

/* ------------------------------ zapis raportu ------------------------------ */

const { writeFileSync } = await import('node:fs');
writeFileSync('docs/evidence/audit-2026-09-15/04-probes-api.txt', out.join('\n') + '\n');
console.log(`\nzapisano ${out.length} wynikow`);
