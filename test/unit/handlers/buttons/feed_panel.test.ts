import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import FeedPanel from '../../../../src/handlers/buttons/feed_panel';
import { feedPanelId } from '../../../../src/handlers/feed-panel/session';
import { err, ok } from '../../../../src/core/result';
import { FeedError } from '../../../../src/core/errors';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import {
  buildPanel,
  message,
  panelMessage,
  panelContent,
  storedSubscription,
} from '../feed-panel/helpers';

const click = async (
  fixture: ReturnType<typeof buildPanel>,
  action: string,
  overrides: Partial<Parameters<typeof buildButtonInteraction>[0]> = {},
) => {
  const sink = newInteractionSink();
  await new FeedPanel().execute(
    buildButtonInteraction({
      guild: fixture.guild,
      message,
      customId: feedPanelId(fixture.session.id, action),
      sink,
      ...overrides,
    }),
    fixture.bot,
  );
  return sink;
};

afterEach(() => vi.useRealTimers());

describe('feed panel button entrypoint', () => {
  it('opens a keyword modal without acknowledging twice, fetching, or writing', async () => {
    const fixture = buildPanel();
    const sink = await click(fixture, 'keyword');
    expect(sink.modals).toHaveLength(1);
    expect(sink.deferUpdates).toHaveLength(0);
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
    expect(fixture.upsert).not.toHaveBeenCalled();
    expect(fixture.session.modalNonce).toBeTruthy();
  });

  it('saves once and rejects a replay after completion', async () => {
    const fixture = buildPanel();
    const saved = await click(fixture, 'save');
    expect(fixture.upsert).toHaveBeenCalledTimes(1);
    expect(panelContent(saved)).toContain('replies:feed.account_subscribed');
    const replay = await click(fixture, 'save');
    expect(panelContent(replay)).toContain('replies:feed.panel.expired');
    expect(fixture.upsert).toHaveBeenCalledTimes(1);
  });

  it('cancels without writing and invalidates Save', async () => {
    const fixture = buildPanel();
    expect(panelContent(await click(fixture, 'cancel'))).toContain('replies:feed.panel.cancelled');
    expect(panelContent(await click(fixture, 'save'))).toContain('replies:feed.panel.expired');
    expect(fixture.upsert).not.toHaveBeenCalled();
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it.each([
    { userId: 'other' },
    { guildId: 'other', guild: undefined },
    { applicationId: 'other' },
    { message: panelMessage('other') },
    { message: undefined },
  ])('refuses Save from a mismatched origin %#', async (override) => {
    const fixture = buildPanel();
    const sink = await click(fixture, 'save', override);
    expect(panelContent(sink)).toContain('replies:feed.panel.forbidden');
    expect(sink.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(fixture.upsert).not.toHaveBeenCalled();
    expect(fixture.find).not.toHaveBeenCalled();
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it('rejects expired Save without a write', async () => {
    vi.useFakeTimers();
    const fixture = buildPanel();
    vi.advanceTimersByTime(600000);
    expect(panelContent(await click(fixture, 'save'))).toContain('replies:feed.panel.expired');
    expect(fixture.upsert).not.toHaveBeenCalled();
  });

  it.each(['visibility', 'bot permissions'] as const)(
    'rechecks %s at Save and keeps a refused draft open',
    async (reason) => {
      const fixture = buildPanel();
      fixture.permissions[reason === 'visibility' ? 'u-1' : 'bot-1'] = [];
      const sink = await click(fixture, 'save');
      expect(panelContent(sink)).toContain(
        reason === 'visibility'
          ? 'replies:feed.invoker_cannot_view'
          : 'replies:feed.missing_bot_permissions',
      );
      expect(fixture.upsert).not.toHaveBeenCalled();
      expect(fixture.fetchTimeline).not.toHaveBeenCalled();
      fixture.permissions['u-1'] = [PermissionFlagsBits.ViewChannel];
      fixture.permissions['bot-1'] = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ];
      await click(fixture, 'save');
      expect(fixture.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves every cursor field when editing an existing canonical target during an upstream outage', async () => {
    const existing = storedSubscription();
    const fixture = buildPanel({
      existing,
      draft: { subscriptionId: existing._id.toString(), filter: { media: 'photo_only' } },
    });
    fixture.fetchTimeline.mockRejectedValue(new Error('upstream offline'));
    await click(fixture, 'save');
    expect(fixture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: existing._id, filter: { media: 'photo_only' } }),
    );
    const written = fixture.upsert.mock.calls[0]?.[0];
    for (const field of ['last_seen_id', 'last_seen_timestamp', 'seen_ids'])
      expect(written).not.toHaveProperty(field);
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it('updates an existing canonical target even when upstream normalization is unavailable', async () => {
    const existing = storedSubscription({
      platform: 'youtube',
      account: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    });
    const unavailable = new FeedError({
      code: 'FEED_NOT_FOUND',
      messageKey: 'errors:feed.not_found',
      messageParams: { platform: 'YouTube', account: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' },
      context: { operation: 'test' },
    });
    const fixture = buildPanel({
      platformId: 'youtube',
      existing,
      draft: {
        accounts: ['UC_x5XG1OV2P6uZZ5FSM9Ttw'],
        subscriptionId: existing._id.toString(),
        filter: { media: 'any', keyword: 'video' },
      },
    });
    fixture.normalizeAccount.mockReturnValue(err(unavailable));
    const sink = await click(fixture, 'save');
    expect(fixture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        existingId: existing._id,
        account: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
        filter: { media: 'any', keyword: 'video' },
      }),
    );
    expect(panelContent(sink)).toContain('replies:feed.account_updated');
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it('carries the original row ID into the atomic write if it disappears after the precheck', async () => {
    const existing = storedSubscription();
    const fixture = buildPanel({ existing, draft: { subscriptionId: existing._id.toString() } });
    fixture.find.mockResolvedValueOnce(ok(existing)).mockResolvedValue(ok(undefined));
    fixture.upsert.mockResolvedValue(
      err(databaseErrorFrom(new Error('Subscription no longer exists'), { operation: 'test' })),
    );
    const sink = await click(fixture, 'save');
    expect(fixture.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: existing._id }),
    );
    const written = fixture.upsert.mock.calls[0]?.[0];
    for (const field of ['last_seen_id', 'last_seen_timestamp', 'seen_ids'])
      expect(written).not.toHaveProperty(field);
    expect(panelContent(sink)).toContain('replies:feed.account_failed');
    expect(panelContent(sink)).not.toContain('replies:feed.account_subscribed');
    expect(fixture.fetchTimeline).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'replaced'] as const)(
    'never recreates a stale %s list row',
    async (state) => {
      const old = storedSubscription();
      const fixture = buildPanel({
        existing: state === 'deleted' ? undefined : storedSubscription(),
        draft: { subscriptionId: old._id.toString() },
      });
      expect(panelContent(await click(fixture, 'save'))).toContain('replies:feed.panel.expired');
      expect(fixture.upsert).not.toHaveBeenCalled();
      expect(fixture.fetchTimeline).not.toHaveBeenCalled();
    },
  );

  it('locks before asynchronous repository checks so simultaneous Save clicks cannot both write', async () => {
    const existing = storedSubscription();
    const fixture = buildPanel({ existing, draft: { subscriptionId: existing._id.toString() } });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.find.mockImplementation(async () => {
      await pending;
      return ok(existing);
    });
    const first = click(fixture, 'save');
    await vi.waitFor(() => expect(fixture.find).toHaveBeenCalled());
    const second = click(fixture, 'save');
    release();
    const results = await Promise.all([first, second]);
    expect(fixture.upsert).toHaveBeenCalledTimes(1);
    expect(results.some((sink) => panelContent(sink).includes('replies:feed.panel.busy'))).toBe(
      true,
    );
  });

  it.each(['unknown', 'save|extra'])(
    'refuses malformed or unsupported actions %s',
    async (action) => {
      const fixture = buildPanel();
      const sink = await click(fixture, action);
      expect(panelContent(sink)).toContain('replies:feed.panel.invalid');
      expect(fixture.upsert).not.toHaveBeenCalled();
    },
  );
});
