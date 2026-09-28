/**
 * DIAGNOSTIC (audit 2026-09-15) — not production code, not part of `pnpm test`.
 *
 * Probes that need no model. Each prints PROBE <id> <OK|GAP> <observation>.
 * "GAP" records a real gap found by the audit; it is a finding, not a crash.
 *
 *   node --experimental-transform-types --no-warnings=ExperimentalWarning scripts/audit-probes.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAuth, subscriptionOnlyEnv, scrubbedEnvKeys } from '@platform/server';

const out: string[] = [];
const probe = (id: string, ok: boolean, note: string) => {
  const line = `PROBE ${id.padEnd(22)} ${(ok ? 'OK ' : 'GAP')} ${note}`;
  out.push(line);
  console.log(line);
};

/* ---------------------- AUTH: degradacja na granicy adaptera --------------- */

const mkCreds = (payload: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-creds-'));
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify(payload));
  return dir;
};

// Fabricated values only — no real credential is ever copied here.
const FAKE = { accessToken: 'FAKE-NOT-A-REAL-TOKEN', refreshToken: 'FAKE-REFRESH' };

{
  const dir = mkdtempSync(join(tmpdir(), 'audit-creds-empty-'));
  const s = probeAuth({ CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
  probe('AUTH-brak-pliku', s.credential.state === 'absent',
    `method=${s.method} credential=${s.credential.state} access=${s.access.state}`);
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = mkCreds({ claudeAiOauth: { ...FAKE, subscriptionType: 'max', expiresAt: Date.now() + 3_600_000 } });
  const s = probeAuth({ CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
  probe('AUTH-wazny', s.credential.state === 'valid' && s.credential.subscriptionType === 'max',
    `credential=${s.credential.state} plan=${s.credential.subscriptionType}`);
  rmSync(dir, { recursive: true, force: true });
}

{
  // Expired an hour ago.
  const expired = Date.now() - 3_600_000;
  const dir = mkCreds({ claudeAiOauth: { ...FAKE, subscriptionType: 'max', expiresAt: expired } });
  const s = probeAuth({ CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
  // Re-checked after the fix: a past expiry must read as `stale`, and must not
  // be reported as verified access. It must also not be treated as a failure —
  // the SDK can still renew the token.
  const honest = s.credential.state === 'stale' && s.access.state !== 'verified';
  probe('AUTH-wygasly', honest,
    honest
      ? `credential=stale access=${s.access.state} (expiresAt ${new Date(expired).toISOString()})`
      : `credential=${s.credential.state} access=${s.access.state} — status nie odroznia wygasniecia`);
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = mkCreds({ claudeAiOauth: { ...FAKE, subscriptionType: 'max', expiresAt: Date.now() + 3_600_000 } });
  const s = probeAuth({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-FAKE' } as NodeJS.ProcessEnv);
  probe('AUTH-klucz-wykryty', s.apiKeyDetected && s.apiKeyPolicy === 'refused',
    `apiKeyDetected=${s.apiKeyDetected} policy=${s.apiKeyPolicy}`);
  const env = subscriptionOnlyEnv({ ANTHROPIC_API_KEY: 'sk-ant-FAKE', PATH: '/usr/bin' } as NodeJS.ProcessEnv);
  probe('AUTH-klucz-usuniety', env.ANTHROPIC_API_KEY === undefined && env.PATH === '/usr/bin',
    `usuniete=${scrubbedEnvKeys({ ANTHROPIC_API_KEY: 'x', CLAUDECODE: '1' } as NodeJS.ProcessEnv).join(',')}`);
  probe('AUTH-brak-tokena-w-statusie', !JSON.stringify(s).includes('FAKE-NOT-A-REAL-TOKEN'),
    'wartosc tokena nie wystepuje w wyniku probeAuth');
  rmSync(dir, { recursive: true, force: true });
}

writeFileSync('docs/evidence/audit-2026-09-15/03-probes-auth.txt', out.join('\n') + '\n');
console.log(`\nzapisano ${out.length} wynikow`);
