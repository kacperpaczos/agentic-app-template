import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertMcpCompatibleShape, buildMcpServer, platformTools } from '@platform/server';
import { createHarness } from './helpers.ts';

/**
 * Regression guard for the failure described in FEEDBACK entry #15.
 *
 * A `z.record()` anywhere in a tool's input schema made the Claude Agent SDK
 * drop the whole MCP server from the session, silently — the model then had no
 * application tools and no error to explain it. These tests keep that class of
 * mistake loud.
 */
describe('zgodnosc schematow narzedzi MCP', () => {
  it('odrzuca z.record() w schemacie narzedzia', () => {
    expect(() =>
      assertMcpCompatibleShape('probe', { filters: z.record(z.string(), z.unknown()) }),
    ).toThrowError(/z\.record/);
  });

  it('odrzuca z.record() zagniezdzony w obiekcie', () => {
    expect(() =>
      assertMcpCompatibleShape('probe', {
        spec: z.object({ props: z.record(z.string(), z.string()) }),
      }),
    ).toThrowError(/z\.record/);
  });

  it('odrzuca z.record() zagniezdzony w unii dyskryminowanej', () => {
    expect(() =>
      assertMcpCompatibleShape('probe', {
        spec: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a'), props: z.record(z.string(), z.unknown()) }),
          z.object({ kind: z.literal('b'), source: z.string() }),
        ]),
      }),
    ).toThrowError(/z\.record/);
  });

  it('odrzuca z.record() pod optional/default', () => {
    expect(() =>
      assertMcpCompatibleShape('probe', {
        a: z.record(z.string(), z.unknown()).optional(),
      }),
    ).toThrowError(/z\.record/);
  });

  it('akceptuje zamienniki zgodne z JSON Schema', () => {
    expect(() =>
      assertMcpCompatibleShape('probe', {
        loose: z.looseObject({}),
        catchall: z.object({}).catchall(z.unknown()),
        unknown: z.unknown(),
        nested: z.object({ inner: z.looseObject({}).optional() }),
        union: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a'), props: z.looseObject({}) }),
          z.object({ kind: z.literal('b'), source: z.string() }),
        ]),
        list: z.array(z.object({ x: z.number() })),
      }),
    ).not.toThrow();
  });

  it('wszystkie realne narzedzia aplikacji przechodza kontrole', async () => {
    const h = await createHarness();
    try {
      const built = buildMcpServer({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
        contextFor: () => {
          throw new Error('nie wolane w tescie');
        },
      });
      expect(built.tools.length).toBeGreaterThanOrEqual(20);
      // Names exposed to the model must be stable and namespaced.
      for (const t of built.tools) expect(t.exposedName).toBe(`mcp__app__${t.localName}`);
      expect(built.tools.map((t) => t.exposedName)).toEqual(
        expect.arrayContaining([
          'mcp__app__get_context',
          'mcp__app__canvas_add_card',
          'mcp__app__procurement_compare_offers',
        ]),
      );
    } finally {
      h.dispose();
    }
  });
});

describe('zod .default() w schemacie narzedzia MCP', () => {
  it('odrzuca .default() na polu najwyzszego poziomu', () => {
    expect(() => assertMcpCompatibleShape('probe', { limit: z.number().default(25) })).toThrowError(
      /\.default\(\)/,
    );
  });

  it('odrzuca .default() zagniezdzony w obiekcie', () => {
    expect(() =>
      assertMcpCompatibleShape('probe', { spec: z.object({ mode: z.string().default('x') }) }),
    ).toThrowError(/\.default\(\)/);
  });

  it('dopuszcza .default() pod .optional() — model nie musi podac pola', () => {
    expect(() =>
      assertMcpCompatibleShape('probe', { a: z.object({ b: z.number().default(1) }).optional() }),
    ).not.toThrow();
  });

  it('dopuszcza .optional()', () => {
    expect(() => assertMcpCompatibleShape('probe', { limit: z.number().optional() })).not.toThrow();
  });
});
