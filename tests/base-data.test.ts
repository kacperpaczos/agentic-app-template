import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_ID, ensureBaseData } from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';

/**
 * A fresh installation opens on real content — once.
 *
 * Two properties, and the second matters more than the first:
 *
 *  1. an empty database gets base data, including a workspace with cards, so the
 *     canvas is not blank and the agent has something to act on;
 *  2. **data the user deletes stays deleted.** A restart that resurrected a
 *     record somebody chose to remove would be worse than an empty start, so the
 *     fact that seeding happened is recorded and not re-derived from "is the
 *     database empty".
 *
 * `createHarness` builds the platform *without* base data on purpose — that is
 * what `ensureBaseData` living in the composition root rather than in
 * `createPlatform` buys: a test that counts rows gets the database it asked for.
 */

let h: Harness;
beforeEach(async () => {
  // `withModule: true` registers the business module but seeds nothing here.
  h = await createHarness({ withModule: true, seed: false });
});
afterEach(() => h.dispose());

const counts = () => ({
  cases: (
    h.platform.db.$client.prepare('SELECT COUNT(*) AS n FROM pc_cases').get() as { n: number }
  ).n,
  files: h.platform.services.files.list(DEFAULT_USER_ID).length,
  spaces: h.platform.services.canvas.listSpaces(DEFAULT_USER_ID).length,
});

describe('dane bazowe przy pierwszym uruchomieniu', () => {
  it('pusta baza dostaje rekordy, pliki i gotowa przestrzen z kartami', async () => {
    expect(counts()).toEqual({ cases: 0, files: 0, spaces: 0 });

    const result = await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID });

    expect(result.seeded).toContain('procurement');
    expect(result.workspaces).toBeGreaterThan(0);

    const after = counts();
    expect(after.cases).toBeGreaterThan(0);
    expect(after.files).toBeGreaterThan(0);
    expect(after.spaces).toBeGreaterThan(0);

    // The canvas is not merely present — it has something on it, which is the
    // difference between "seeded" and "not empty on screen".
    const space = h.platform.services.canvas.listSpaces(DEFAULT_USER_ID)[0]!;
    const state = h.platform.services.canvas.getState(space.id, DEFAULT_USER_ID);
    expect(state.cards.length).toBeGreaterThan(0);
  });

  it('drugie uruchomienie nic nie dopisuje', async () => {
    await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID });
    const first = counts();

    const second = await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID });

    expect(second.seeded).toEqual([]);
    expect(second.skipped).toContain('procurement');
    expect(second.workspaces).toBe(0);
    expect(counts()).toEqual(first);
  });

  it('usuniete dane bazowe NIE wracaja przy kolejnym starcie', async () => {
    await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID });
    const space = h.platform.services.canvas.listSpaces(DEFAULT_USER_ID)[0]!;

    // The user throws the demo workspace away.
    h.platform.db.$client.prepare('DELETE FROM canvas_spaces WHERE id = ?').run(space.id);
    expect(counts().spaces).toBe(0);

    await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID });

    /*
     * The decisive assertion. Deciding from "is the database empty" would put it
     * straight back, and the user would have no way to keep it gone.
     */
    expect(counts().spaces, 'skasowana przestrzen wrocila po restarcie').toBe(0);
  });

  it('force ponawia zasiew, ale nie duplikuje rekordow', async () => {
    await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID });
    const first = counts();

    const forced = await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID, force: true });

    expect(forced.seeded).toContain('procurement');
    // The module fixture guards itself, so a forced run adds nothing that is
    // still there — `--force` is a repair path, not a duplication path.
    expect(counts().cases).toBe(first.cases);
    expect(counts().files).toBe(first.files);
  });

  it('istniejaca praca uzytkownika nie jest ruszana', async () => {
    const mine = h.platform.services.canvas.createSpace({
      ownerId: DEFAULT_USER_ID,
      title: 'Moja przestrzen',
    });
    const conv = h.platform.services.conversations.create({
      ownerId: DEFAULT_USER_ID,
      firstMessage: { content: 'moja rozmowa' },
    });

    await ensureBaseData(h.platform, { ownerId: DEFAULT_USER_ID });

    // Added alongside, never over: both survive untouched.
    expect(
      h.platform.services.canvas.listSpaces(DEFAULT_USER_ID).map((s) => s.id),
    ).toContain(mine.id);
    // The title is derived from the first message (and capitalised there).
    expect(h.platform.services.conversations.get(conv.id, DEFAULT_USER_ID).title).toBe(
      'Moja rozmowa',
    );
    expect(h.platform.services.conversations.messages(conv.id, DEFAULT_USER_ID)).toHaveLength(1);
  });
});
