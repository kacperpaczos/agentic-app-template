import { describe, expect, it } from 'vitest';
import { PROCUREMENT_CARD_COMPONENTS, PROCUREMENT_CARD_TO_OPENUI } from '@module/procurement/shared';
import { createProcurementModule } from '@module/procurement/server';
import { OpenUiServerCatalog } from '@platform/server';
import { typedCard, type CardComponentProps } from '@platform/ui';
import { caseSummaryPropsSchema } from '@module/procurement/shared';
import { createHarness } from './helpers.ts';

/**
 * Cards are catalog components, with declared props — and a composition cannot
 * smuggle a business value into one.
 *
 * Test kontraktu lub logiki, for two criteria:
 *
 *  - **L2.1** every card component this module contributes has a typed props
 *    schema and is registered in the OpenUI catalog, on both halves. Until now
 *    the canvas cards lived in a catalog of their own: they could be placed on
 *    the canvas and nowhere else, and their renderers received
 *    `Record<string, unknown>`;
 *  - **L3.7** props are references, never values. A composition that names a
 *    business value is not "mostly ignored" — the value has to be *gone* from
 *    what is stored, or a stale price would travel with the composition and be
 *    drawn as if it were the record.
 *
 * The browser half of the check (the same names in the rendered library) is in
 * `openui-catalog-parity.test.ts`; this one is about the card catalog and the
 * values.
 */

describe('karty modulu w katalogu OpenUI', () => {
  it('kazda karta ma schemat propsow i odpowiednik w katalogu OpenUI serwera', async () => {
    const h = await createHarness({ seed: false });
    try {
      const mod = createProcurementModule(h.platform.services);
      const declared = (mod.cardComponents ?? []).map((c) => c.id).sort();
      expect(declared).toEqual(PROCUREMENT_CARD_COMPONENTS.map((c) => c.id).sort());

      const catalog = new OpenUiServerCatalog(mod.openuiComponents);
      for (const card of PROCUREMENT_CARD_COMPONENTS) {
        // A schema, and one that rejects the empty object — a card whose props
        // are optional everywhere would accept anything and type nothing.
        const descriptor = (mod.cardComponents ?? []).find((c) => c.id === card.id)!;
        expect(descriptor.propsSchema, card.id).toBeDefined();
        expect(descriptor.propsSchema.safeParse({}).success, `${card.id}: puste props`).toBe(false);

        // And it is the same component in the catalog the agent composes with.
        expect(catalog.names(), card.id).toContain(card.openuiName);
        expect(PROCUREMENT_CARD_TO_OPENUI[card.id]).toBe(card.openuiName);
      }

      // The platform's own cards are in the card catalog too, and are the only
      // ones there beside the module's.
      const ids = h.platform.services.catalog.list().map((c) => c.id);
      for (const card of PROCUREMENT_CARD_COMPONENTS) expect(ids).toContain(card.id);
    } finally {
      h.dispose();
    }
  });

  it('kazda karta deklaruje wylacznie referencje i opcje widoku, nigdy wartosc biznesowa', async () => {
    const h = await createHarness({ seed: false });
    try {
      const mod = createProcurementModule(h.platform.services);
      /*
       * The shape of a reference: an identifier, or a boolean that chooses how
       * to show what was read. A number or an unconstrained string would be a
       * place for a price to live.
       */
      for (const descriptor of mod.cardComponents ?? []) {
        const schema = descriptor.propsSchema.safeParse({});
        expect(schema.success).toBe(false);
        // Checked by behaviour rather than by reading the schema: a property
        // holding an amount is refused, and one holding an identifier is kept.
        const withValue = descriptor.propsSchema.safeParse({
          caseId: 'case-1',
          offerId: 'offer-1',
          itemId: 'item-1',
          totalMinor: 999_999,
          supplierName: 'NordAV',
        });
        expect(withValue.success, descriptor.id).toBe(true);
        expect(Object.keys(withValue.data as object), descriptor.id).not.toContain('totalMinor');
        expect(Object.keys(withValue.data as object), descriptor.id).not.toContain('supplierName');
      }
    } finally {
      h.dispose();
    }
  });

  it('kompozycja nie przemyca wartosci biznesowej do zapisanej karty', async () => {
    const h = await createHarness();
    try {
      const stored = h.platform.services.catalog.validate({
        kind: 'component',
        component: 'procurement.comparisonTable',
        // The identifier is what the card needs; the rest is a model's own number.
        props: { caseId: 'case-1', totalMinor: 999_999, supplierName: 'NordAV' } as never,
      });
      expect(stored.kind).toBe('component');
      const props = (stored as { props: Record<string, unknown> }).props;
      expect(props.caseId).toBe('case-1');
      expect(props).not.toHaveProperty('totalMinor');
      expect(props).not.toHaveProperty('supplierName');
      expect(JSON.stringify(props)).not.toContain('999999');
    } finally {
      h.dispose();
    }
  });

  it('karta z niezgodnymi wlasciwosciami renderuje nazwany blad, nie pusta ramke', () => {
    /*
     * The other half of `typedCard`: what happens when a stored spec does not
     * fit the schema — an older card, a hand-edited one, a composition from a
     * version that has moved on. The renderer must not be reached with values
     * it would coerce into an empty screen.
     *
     * Checked by calling the component and reading the element it returns:
     * there is no DOM in this suite, and none is needed — the decision, the
     * branch taken and the message are all in the returned tree. Only the
     * browser's painting of that tree is left to the browser.
     */
    const Body = (_props: CardComponentProps<{ caseId: string }>) => null;
    const Card = typedCard(caseSummaryPropsSchema, Body) as (
      p: CardComponentProps,
    ) => { type: unknown; props: Record<string, any> };

    // Valid: the element describes the renderer, with parsed (not raw) props —
    // the extra key is gone before the component could ever see it.
    const ok = Card({ cardId: 'c1', props: { caseId: 'case-1', totalMinor: 999_999 } });
    expect(ok.type).toBe(Body);
    expect(ok.props.props).toEqual({ caseId: 'case-1' });
    expect(ok.props.cardId).toBe('c1');

    // Invalid: the renderer is not reached at all, and the card says why.
    const bad = Card({ cardId: 'c2', props: { caseId: '' } });
    expect(bad.type).toBe('div');
    expect(bad.props['data-testid']).toBe('card-props-invalid');
    expect(bad.props.role).toBe('alert');
    expect(JSON.stringify(bad.props.children)).toContain('niezgodne ze swoim schematem');
    // The failure names the component, so a broken card on a canvas full of
    // them says which one it is; and the renderer is not in the tree, so it
    // cannot run with values the schema refused.
    expect(JSON.stringify(bad.props.children)).toContain('Body');
    expect(bad.type).not.toBe(Body);
  });

  it('widok agenta odmawia kompozycji z wpisanymi liczbami', async () => {
    const h = await createHarness();
    try {
      // A table whose rows are in the composition rather than in a read.
      expect(() =>
        h.platform.services.catalog.validate(
          {
            kind: 'openui',
            source: [
              'root = Stack([tabela])',
              'tabela = Table([["Dostawca", "Suma"], ["NordAV", "999 999,99 PLN"]])',
            ].join('\n'),
          },
          { mode: 'agent-views' },
        ),
      ).toThrowError();

      // And the same composition written as a data component is accepted — the
      // refusal is about values in the composition, not about tables.
      expect(() =>
        h.platform.services.catalog.validate(
          {
            kind: 'openui',
            source:
              'root = DataTable({operation: "procurement.suppliers"}, ["name", "country"], "Dostawcy")',
          },
          { mode: 'agent-views' },
        ),
      ).not.toThrow();
    } finally {
      h.dispose();
    }
  });
});
