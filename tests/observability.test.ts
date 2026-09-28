import { setTimeout as sleep } from 'node:timers/promises';
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
 *
 * The same standard applies to "running without telemetry": the first test once
 * asserted only `toBeTruthy()`. It now measures the no-export state through the
 * public `mastra.observability` entrypoint (no registered instance, no exporter,
 * a no-op trace lookup) and through a nagging logger that records every call.
 */
describe('punkt wpiecia telemetrii', () => {
  it('bez konfiguracji telemetrii nie ma zarejestrowanego eksportera i nic nie jest wysylane', async () => {
    /*
     * Dokladnie taka konstrukcja, jaka wykonuje `agent/runtime.ts`: `new Mastra`
     * bez `observability`. „Nic nie wysyla” jest tu zmierzone, nie zalozone:
     *  1. publiczny punkt wejscia `mastra.observability` musi byc no-op — zadna
     *     instancja/eksporter nie jest zarejestrowana, wiec nie MA dokad wysylac;
     *  2. naganny logger (wzor testu nizej) zbiera wszystkie wywolania i zadne
     *     z nich nie zapowiada eksportu telemetrii — wplywaja wylacznie znane
     *     ostrzezenia konfiguracyjne (in-memory storage, brak adaptora).
     * Obiekty `expect(...).toBeTruthy()` nie wystarcza: konstrukcja „nie rzuca”
     * nawet gdy telemetria jest zle wpisana (test nizej).
     */
    const calls: Array<{ level: string; text: string }> = [];
    const record = (level: string) => (...args: unknown[]) =>
      calls.push({ level, text: args.map((a) => String(a)).join(' ') });
    const mastra = new Mastra({
      agents: {},
      logger: {
        warn: record('warn'),
        info: record('info'),
        error: record('error'),
        debug: record('debug'),
        trackException: record('trackException'),
      } as never,
    });

    // 1) Stan eksportu: brak instancji domyslnej i jakiejkolwiek innej.
    expect(mastra.observability.getDefaultInstance()).toBeUndefined();
    expect(mastra.observability.listInstances().size).toBe(0);
    expect(mastra.observability.hasInstance('default')).toBe(false);
    // getRecordedTrace jest opcjonalne w typie entrypointu — brak metody tez by tu padl.
    await expect(mastra.observability.getRecordedTrace?.({ traceId: 'probe' })).resolves.toBeNull();

    // 2) Logger zyje (dowolna aktywnosc dochodzi), a mimo to zadna wiadomosc
    //    nie zapowiada eksportu; bledy i wyjatki telemetrii — zero.
    await sleep(0); // ostrzezenie o storage idzie z mikrozadania
    const joined = calls.map((c) => c.text).join(' | ');
    expect(joined).toMatch(/in-memory store/); // kolektor nie jest gluchy
    expect(joined).not.toMatch(/exporter|serviceName|OTLP|telemetry/i);
    expect(calls.filter((c) => c.level === 'error' || c.level === 'trackException')).toEqual([]);
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
