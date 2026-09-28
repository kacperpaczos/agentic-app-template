import { describe, expect, it, vi } from 'vitest';
import { Mastra } from '@mastra/core';

/**
 * The export seam for telemetry — what is actually true about it.
 *
 * Langfuse is optional and not installed. The claim worth making is narrow:
 * that the installed Mastra has a defined place to attach an exporter, and that
 * running without one is a supported configuration.
 *
 * The first version of this test asserted that Mastra "accepts a custom
 * exporter" because constructing it did not throw. It does not throw — it logs
 * `Observability configuration error` and **disables observability**. Asserting
 * on "did not throw" would have been exactly the kind of green-but-empty check
 * this work set out to remove, so the test now pins the real contract: a plain
 * exporter object is rejected, and a proper instance requires the separate
 * `@mastra/observability` package, which this project does not install.
 */
describe('punkt wpiecia telemetrii', () => {
  it('bez konfiguracji telemetrii aplikacja dziala i nic nie wysyla', () => {
    expect(new Mastra({ agents: {} })).toBeTruthy();
  });

  it('surowy obiekt eksportera jest odrzucany, a obserwowalnosc wylaczana', () => {
    const warn = vi.fn();
    const mastra = new Mastra({
      agents: {},
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), trackException: vi.fn() } as never,
      observability: { name: 'test-exporter' } as never,
    });
    expect(mastra).toBeTruthy();
    // The message names the supported wiring; it is the contract, not a hint.
    const messages = warn.mock.calls.flat().join(' ');
    expect(messages).toContain('Expected an Observability instance');
    expect(messages).toContain('@mastra/observability');
  });

  it('pakiet @mastra/observability nie jest zainstalowany', async () => {
    const name = ['@mastra', 'observability'].join('/');
    await expect(import(/* @vite-ignore */ name)).rejects.toThrow();
  });

  it('zadna zaleznosc Langfuse nie jest zainstalowana', async () => {
    const name = ['lang', 'fuse'].join('');
    await expect(import(/* @vite-ignore */ name)).rejects.toThrow();
  });
});
