import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildMcpServer,
  createSdkMcpServer,
  platformTools,
  sdkTool as tool,
  toolEffectNote,
} from '@platform/server';
import { cardGeometrySchema } from '@platform/contracts';
import { createHarness } from './helpers.ts';
import {
  callPublishedTool,
  publishedTools,
  type JsonSchemaNode,
} from './support/mcp-published.ts';

/**
 * What the SDK actually publishes, as opposed to what the static guard assumes.
 *
 * `tests/mcp-schema.test.ts` checks that `assertMcpCompatibleShape` rejects the
 * shapes it is meant to reject. That is a test of our own walk. This file asks
 * the other half of the question — *is the walk right about the SDK?* — by
 * reading the JSON Schema the SDK derives from every real tool and by calling
 * tools through the server's own validation.
 *
 * Rodzaj dowodu: **test kontraktu lub logiki** against the real
 * `@anthropic-ai/claude-agent-sdk` conversion. No model turn, no network: the
 * conversion and the validation both happen in this process.
 *
 * The three properties, and why each one is here:
 *
 *  1. every declared tool is announced — the count and the names match, which is
 *     the local half of L9.13's "próba wykrycia";
 *  2. one unconvertible schema empties the **whole** server's tool list and says
 *     nothing about it — reproduced, so the reason `assertMcpCompatibleShape`
 *     exists is a demonstrated fact on this SDK version rather than a story in a
 *     comment (L7.11);
 *  3. a `.default()` nested under an `.optional()` is announced as *not*
 *     required and is filled in at call time when the parent object is
 *     supplied — the exact semantics the guard permits and nobody had checked
 *     (L9.13).
 */

/** Names the JSON Schema marks as required, or an empty list. */
const requiredOf = (node: { required?: string[] } | undefined): string[] => node?.required ?? [];

const propertyOf = (
  node: { properties?: Record<string, JsonSchemaNode> } | undefined,
  name: string,
): JsonSchemaNode | undefined => node?.properties?.[name];

describe('schemat, ktory Claude Agent SDK naprawde oglasza', () => {
  it('kazde zadeklarowane narzedzie jest ogloszone, z opisem i schematem obiektu', async () => {
    const h = await createHarness();
    try {
      const built = buildMcpServer({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
        contextFor: () => {
          throw new Error('nie wolane w tescie');
        },
      });
      const published = await publishedTools(built.server);

      expect(published.map((t) => t.name).sort()).toEqual(
        built.tools.map((t) => t.localName).sort(),
      );
      const effectOf = new Map(built.tools.map((t) => [t.localName, t.effect]));
      for (const t of published) {
        expect(t.inputSchema.type, `${t.name}: schemat wejscia nie jest obiektem`).toBe('object');
        expect((t.description ?? '').length, `${t.name}: brak opisu dla modelu`).toBeGreaterThan(20);
        /*
         * L9.16: the effect and the access scope are stated to the model, on
         * every tool. Asserted against the description the SDK publishes, not
         * against the definition — the note is appended in `buildMcpServer`, and
         * this is the only place that shows it survived the conversion.
         */
        const effect = effectOf.get(t.name);
        expect(effect, `${t.name}: narzedzie bez zadeklarowanego effect`).toBeTruthy();
        expect(t.description, `${t.name}: opis nie podaje skutku`).toContain(
          toolEffectNote(effect!),
        );
      }
      // Reads and writes are both present, so the loop above checked both notes.
      expect(new Set(effectOf.values())).toEqual(new Set(['read', 'write']));
    } finally {
      h.dispose();
    }
  });

  /**
   * The failure `assertMcpCompatibleShape` exists to prevent, performed.
   *
   * The conversion of the whole list is one operation, so one unconvertible
   * tool takes the answer down with it: `tools/list` throws, and the healthy
   * tool beside it is never announced. What makes this dangerous is where the
   * throw lands — nowhere the operator can see. In a live session (recorded by
   * `pnpm diag`, `docs/evidence/z11-bl03/diag-*.log`) the same server reports
   * `status: "connected"` with **zero tools and no error**, so the model simply
   * has no application tools and nothing says why.
   */
  it('jedno niekonwertowalne narzedzie zabiera cala liste narzedzi serwera', async () => {
    const healthy = tool('zdrowe', 'Zwykle narzedzie probne.', { a: z.string() }, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const unconvertible = tool(
      'niekonwertowalne',
      'Uzywa z.record(), czego SDK nie zamienia na JSON Schema.',
      { m: z.record(z.string(), z.string()) },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    );

    const broken = createSdkMcpServer({ name: 'probe', version: '0.1.0', tools: [healthy, unconvertible] });
    const outcome = await publishedTools(broken).then(
      (tools) => ({ listed: tools.map((t) => t.name) }),
      (err: unknown) => ({ blad: err instanceof Error ? err.message : String(err) }),
    );
    expect(
      outcome,
      'SDK przestal gubic narzedzia na z.record() — straznik assertMcpCompatibleShape wymaga ponownej oceny',
    ).not.toHaveProperty('listed');

    // The control: the same healthy tool, alone, is announced normally. Without
    // this the assertion above would also pass if `publishedTools` were broken.
    const fine = createSdkMcpServer({ name: 'probe', version: '0.1.0', tools: [healthy] });
    expect((await publishedTools(fine)).map((t) => t.name)).toEqual(['zdrowe']);
  });

  /**
   * The semantics L9.13 names: a `.default()` under an `.optional()`.
   *
   * Two questions, because a schema and a validator can disagree: how is the
   * field announced, and what happens when the model supplies the parent object
   * without it? The shapes are the application's own — `cardGeometrySchema`
   * carries `z: z.number().int().default(0)`, and `canvas_add_card` /
   * `canvas_move_card` pass it through `.partial()` with and without
   * `.optional()`.
   */
  it('domyslne pole pod optional nie jest wymagane, a wartosc domyslna wchodzi przy wywolaniu', async () => {
    let received: unknown = null;
    const probe = createSdkMcpServer({
      name: 'probe',
      version: '0.1.0',
      tools: [
        tool(
          'geometria',
          'Ksztalty geometrii karty, takie jak w narzedziach canvasu.',
          {
            /* `canvas_add_card`: the whole object may be omitted. */
            opcjonalna: cardGeometrySchema.partial().optional(),
            /* `canvas_move_card`: the object is required, its fields are not. */
            wymagana: cardGeometrySchema.partial(),
          },
          async (args: unknown) => {
            received = args;
            return { content: [{ type: 'text' as const, text: JSON.stringify(args) }] };
          },
        ),
      ],
    });

    const [announced] = await publishedTools(probe);
    expect(announced, 'narzedzie probne nie zostalo ogloszone').toBeTruthy();

    // The object under `.optional()` is not demanded; the one without it is.
    expect(requiredOf(announced!.inputSchema)).toEqual(['wymagana']);

    for (const parent of ['opcjonalna', 'wymagana'] as const) {
      const node = propertyOf(announced!.inputSchema, parent);
      expect(node, `${parent}: brak w ogloszonym schemacie`).toBeTruthy();
      const defaulted = propertyOf(node, 'z');
      expect(defaulted?.default, `${parent}.z: SDK nie oglasza wartosci domyslnej`).toBe(0);
      /*
       * The assertion the guard's allowance rests on. A defaulted field
       * announced as required is the failure documented on
       * `assertMcpCompatibleShape`: the model omits it legitimately and the call
       * dies on "expected nonoptional, received undefined".
       */
      expect(
        requiredOf(node),
        `${parent}.z: pole z wartoscia domyslna ogloszone jako WYMAGANE`,
      ).not.toContain('z');
    }

    // Parent supplied, defaulted field omitted: accepted, and filled in.
    const ok = await callPublishedTool(probe, 'geometria', { wymagana: { x: 10, y: 20 } });
    expect(ok.ok, `wywolanie odrzucone: ${ok.text}`).toBe(true);
    expect((received as { wymagana: { z?: number } }).wymagana.z).toBe(0);

    // And the object that is *not* optional really is demanded — the control
    // that keeps the first assertion from passing on an empty schema.
    const missing = await callPublishedTool(probe, 'geometria', {});
    expect(missing.ok).toBe(false);
    expect(missing.text).toMatch(/wymagana/);
  });
});
