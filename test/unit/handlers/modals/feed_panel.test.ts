import { describe, expect, it } from 'vitest';
import FeedPanelModal from '../../../../src/handlers/modals/feed_panel';
import FeedPanelButton from '../../../../src/handlers/buttons/feed_panel';
import { feedPanelId } from '../../../../src/handlers/feed-panel/session';
import {
  buildButtonInteraction,
  buildModalSubmitInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildPanel, message, panelMessage, panelContent } from '../feed-panel/helpers';

const openModal = async (fixture: ReturnType<typeof buildPanel>): Promise<string> => {
  const sink = newInteractionSink();
  await new FeedPanelButton().execute(
    buildButtonInteraction({
      guild: fixture.guild,
      message,
      customId: feedPanelId(fixture.session.id, 'keyword'),
      sink,
    }),
    fixture.bot,
  );
  const modal = sink.modals[0] as { toJSON(): { custom_id: string } };
  return modal.toJSON().custom_id;
};

const submit = async (
  fixture: ReturnType<typeof buildPanel>,
  customId: string,
  keyword: string,
  overrides: Partial<Parameters<typeof buildModalSubmitInteraction>[0]> = {},
) => {
  const sink = newInteractionSink();
  await new FeedPanelModal().execute(
    buildModalSubmitInteraction({
      guild: fixture.guild,
      message,
      customId,
      textInputs: { keyword },
      sink,
      ...overrides,
    }),
    fixture.bot,
  );
  return sink;
};

describe('feed keyword modal entrypoint', () => {
  it('stores a trimmed boolean expression only in the draft', async () => {
    const fixture = buildPanel();
    const sink = await submit(fixture, await openModal(fixture), ' live OR (album AND tour) ');
    expect(fixture.session.draft).toMatchObject({
      filter: { keyword: 'live OR (album AND tour)' },
    });
    expect(panelContent(sink)).toContain('replies:feed.filter_keyword');
    expect(fixture.upsert).not.toHaveBeenCalled();
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it('clears an existing keyword with blank text while preserving other filters', async () => {
    const fixture = buildPanel({
      platformId: 'youtube',
      draft: { filter: { media: 'any', keyword: 'old' } },
    });
    await submit(fixture, await openModal(fixture), '  ');
    expect(fixture.session.draft).toMatchObject({ filter: { media: 'any' } });
    expect(fixture.session.draft).not.toHaveProperty('filter.keyword');
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['live OR (album', 'replies:feed.keyword_invalid'],
    ['a'.repeat(101), 'replies:feed.keyword_too_long'],
  ])('rejects invalid text without changing the old filter: %s', async (keyword, key) => {
    const fixture = buildPanel({ draft: { filter: { media: 'any', keyword: 'old' } } });
    const sink = await submit(fixture, await openModal(fixture), keyword);
    expect(panelContent(sink)).toContain(key);
    expect(fixture.session.draft).toMatchObject({ filter: { keyword: 'old' } });
    expect(fixture.session.modalNonce).toBeUndefined();
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it('rejects an older modal after a new one opens and consumes a successful nonce once', async () => {
    const fixture = buildPanel();
    const oldId = await openModal(fixture);
    const currentId = await openModal(fixture);
    expect(currentId).not.toBe(oldId);
    expect(panelContent(await submit(fixture, oldId, 'stale'))).toContain(
      'replies:feed.panel.expired',
    );
    await submit(fixture, currentId, 'current');
    expect(panelContent(await submit(fixture, currentId, 'replay'))).toContain(
      'replies:feed.panel.expired',
    );
    expect(fixture.session.draft).toMatchObject({ filter: { keyword: 'current' } });
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { message: undefined },
    { message: panelMessage('other') },
    { userId: 'other' },
    { applicationId: 'other' },
    { guild: undefined, guildId: 'other' },
  ])('rejects a modal with the wrong origin %#', async (overrides) => {
    const fixture = buildPanel();
    const id = await openModal(fixture);
    expect(panelContent(await submit(fixture, id, 'wrong', overrides))).toContain(
      'replies:feed.panel.forbidden',
    );
    expect(fixture.session.draft).not.toHaveProperty('filter.keyword');
    expect(fixture.upsert).not.toHaveBeenCalled();
    await submit(fixture, id, 'valid');
    expect(fixture.session.draft).toMatchObject({ filter: { keyword: 'valid' } });
  });
});
