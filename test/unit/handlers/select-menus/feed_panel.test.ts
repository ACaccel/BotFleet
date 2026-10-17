import { describe, expect, it } from 'vitest';
import FeedPanelSelect from '../../../../src/handlers/select-menus/feed_panel';
import FeedPanelButton from '../../../../src/handlers/buttons/feed_panel';
import { feedPanelId } from '../../../../src/handlers/feed-panel/session';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import {
  buildButtonInteraction,
  buildStringSelectInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import {
  buildPanel,
  message,
  panelComponents,
  panelContent,
  panelMessage,
  storedSubscription,
} from '../feed-panel/helpers';

const select = async (
  fixture: ReturnType<typeof buildPanel>,
  action: string,
  values: readonly string[],
  overrides: Partial<Parameters<typeof buildStringSelectInteraction>[0]> = {},
) => {
  const sink = newInteractionSink();
  await new FeedPanelSelect().execute(
    buildStringSelectInteraction({
      guild: fixture.guild,
      message,
      customId: feedPanelId(fixture.session.id, action),
      values,
      sink,
      ...overrides,
    }),
    fixture.bot,
  );
  return sink;
};

const listDraft = (fixture: ReturnType<typeof buildPanel>, count = 1) => {
  const docs = Array.from({ length: count }, (_, index) =>
    storedSubscription({ account: `target${String(index)}` }),
  );
  fixture.session.draft = {
    kind: 'list',
    page: 0,
    targets: docs.map((doc) => ({
      id: doc._id.toString(),
      platform: doc.platform,
      account: doc.account,
      channelId: doc.channel_id,
    })),
  };
  return docs;
};

describe('feed panel select entrypoint', () => {
  it('edits media in memory and writes only after Save', async () => {
    const fixture = buildPanel();
    await select(fixture, 'media', ['video_only']);
    expect(fixture.session.draft).toMatchObject({ filter: { media: 'video_only' } });
    expect(fixture.upsert).not.toHaveBeenCalled();
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
    await new FeedPanelButton().execute(
      buildButtonInteraction({
        guild: fixture.guild,
        message,
        customId: feedPanelId(fixture.session.id, 'save'),
      }),
      fixture.bot,
    );
    expect(fixture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { media: 'video_only' } }),
    );
  });

  it.each([
    ['youtube', 'media', ['any']],
    ['x', 'releases', ['all']],
    ['x', 'media', ['bogus']],
    ['x', 'media', []],
    ['x', 'media', ['any', 'photo_only']],
  ])('rejects irrelevant or forged filter values for %s/%s', async (platformId, action, values) => {
    const fixture = buildPanel({ platformId });
    const before = JSON.stringify(fixture.session.draft);
    expect(panelContent(await select(fixture, action, values))).toContain(
      'replies:feed.panel.invalid',
    );
    expect(JSON.stringify(fixture.session.draft)).toBe(before);
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it('rereads the selected row and preloads its current filter', async () => {
    const fixture = buildPanel();
    const docs = listDraft(fixture);
    const doc = {
      ...docs[0]!,
      filter: { media: 'photo_only' as const, keyword: 'changed meanwhile' },
    };
    fixture.find.mockResolvedValue(ok(doc));
    const sink = await select(fixture, 'target', [doc._id.toString()]);
    expect(fixture.find).toHaveBeenCalledWith('x', doc.account, 'c-1');
    expect(fixture.session.draft).toMatchObject({
      kind: 'filter',
      subscriptionId: doc._id.toString(),
      filter: doc.filter,
    });
    expect(panelContent(sink)).toContain('changed meanwhile');
    expect(fixture.upsert).not.toHaveBeenCalled();
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it('saves the selected original row with its ID and leaves every cursor field untouched', async () => {
    const fixture = buildPanel();
    const docs = listDraft(fixture);
    const doc = docs[0]!;
    fixture.find.mockResolvedValue(ok(doc));
    await select(fixture, 'target', [doc._id.toString()]);
    await select(fixture, 'media', ['photo_only']);
    await new FeedPanelButton().execute(
      buildButtonInteraction({
        guild: fixture.guild,
        message,
        customId: feedPanelId(fixture.session.id, 'save'),
      }),
      fixture.bot,
    );
    expect(fixture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        existingId: doc._id,
        account: doc.account,
        filter: { media: 'photo_only', keyword: 'old' },
      }),
    );
    const written = fixture.upsert.mock.calls[0]?.[0];
    for (const field of ['last_seen_id', 'last_seen_timestamp', 'seen_ids'])
      expect(written).not.toHaveProperty(field);
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it('rechecks target visibility before rereading a selected subscription', async () => {
    const fixture = buildPanel();
    const docs = listDraft(fixture);
    fixture.permissions['u-1'] = [];
    expect(panelContent(await select(fixture, 'target', [docs[0]!._id.toString()]))).toContain(
      'replies:feed.invoker_cannot_view',
    );
    expect(fixture.find).not.toHaveBeenCalled();
    expect(fixture.session.draft.kind).toBe('list');
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'replaced', 'database'] as const)(
    'refuses a %s row without entering the editor',
    async (state) => {
      const fixture = buildPanel();
      const docs = listDraft(fixture);
      if (state === 'database')
        fixture.find.mockResolvedValue(
          err(databaseErrorFrom(new Error('offline'), { operation: 'test' })),
        );
      else
        fixture.find.mockResolvedValue(ok(state === 'deleted' ? undefined : storedSubscription()));
      const sink = await select(fixture, 'target', [docs[0]!._id.toString()]);
      expect(panelContent(sink)).toContain(
        state === 'database' ? 'replies:feed.failed' : 'replies:feed.panel.expired',
      );
      expect(fixture.session.draft.kind).toBe('list');
      expect(fixture.upsert).not.toHaveBeenCalled();
    },
  );

  it('limits each selector page to 25 and handles both navigation boundaries', async () => {
    const fixture = buildPanel();
    const docs = listDraft(fixture, 26);
    const page = async (action: string) => {
      const sink = newInteractionSink();
      await new FeedPanelButton().execute(
        buildButtonInteraction({
          guild: fixture.guild,
          message,
          customId: feedPanelId(fixture.session.id, action),
          sink,
        }),
        fixture.bot,
      );
      return panelComponents(sink.editReplies.at(-1));
    };
    const first = await page('previous');
    expect(first[0]?.options).toHaveLength(25);
    expect(first.find((component) => component.custom_id?.includes('|previous|'))?.disabled).toBe(
      true,
    );
    const next = await page('next');
    expect(next[0]?.options?.map((option) => option.value)).toEqual([docs[25]!._id.toString()]);
    expect(next.find((component) => component.custom_id?.includes('|next|'))?.disabled).toBe(true);
    expect((await page('next'))[0]?.options).toHaveLength(1);
    expect((await page('previous'))[0]?.options).toHaveLength(25);
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it('rejects forged target IDs before reading the database', async () => {
    const fixture = buildPanel();
    listDraft(fixture);
    expect(panelContent(await select(fixture, 'target', ['forged']))).toContain(
      'replies:feed.panel.invalid',
    );
    expect(fixture.find).not.toHaveBeenCalled();
  });

  it.each([
    { message: undefined },
    { message: panelMessage('other') },
    { userId: 'other' },
    { applicationId: 'other' },
    { guild: undefined, guildId: 'other' },
  ])('rejects select interactions from the wrong origin %#', async (overrides) => {
    const fixture = buildPanel();
    expect(panelContent(await select(fixture, 'media', ['photo_only'], overrides))).toContain(
      'replies:feed.panel.forbidden',
    );
    expect(fixture.session.draft).toMatchObject({ filter: { media: 'any' } });
    expect(fixture.upsert).not.toHaveBeenCalled();
  });
});
