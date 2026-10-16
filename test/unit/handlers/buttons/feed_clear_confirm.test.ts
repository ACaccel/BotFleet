/**
 * The button that actually clears a channel's feed subscriptions.
 *
 * This is where `/feed unsubscribe`'s widest scope commits, so the
 * suite asserts on what reaches the repository, not only on the reply:
 * every refusal branch must leave `deleteWhere` untouched. The customId
 * is a public value and the gap between prompt and click is long enough
 * for a permission to be revoked in, so the handler re-derives the
 * guild, the repositories, and the invoker's visibility from scratch —
 * and each of those re-checks is tested here.
 */
import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { Types } from 'mongoose';

import FeedClearConfirm from '../../../../src/handlers/buttons/feed_clear_confirm';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const CHANNEL_ID = 'chan-home';
const INVOKER_ID = 'u-1';
const STRANGER_ID = 'u-2';

const subscription = (overrides: Partial<FeedSubscriptionDoc> = {}): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform: 'fake',
  account: 'someone',
  channel_id: CHANNEL_ID,
  created_by: INVOKER_ID,
  created_at: 1_700_000_000_000,
  filter: { media: 'media_only' },
  ...overrides,
});

interface Fixture {
  /** Who pressed the button; defaults to the member who was asked. */
  readonly pressedBy?: string;
  /** Overrides the encoded customId wholesale. */
  readonly customId?: string;
  readonly deleted?: readonly FeedSubscriptionDoc[];
  readonly repoFails?: boolean;
  /** Permissions the presser holds; defaults to ViewChannel. */
  readonly permissions?: readonly bigint[];
  /** Leaves the presser out of the member cache — permissions unknowable. */
  readonly memberMissing?: boolean;
  /** No `Repos` for this guild, as a disconnected database looks. */
  readonly reposMissing?: boolean;
}

const build = (fixture: Fixture = {}) => {
  const presser = fixture.pressedBy ?? INVOKER_ID;
  const permissionsBySubject = {
    [presser]: fixture.permissions ?? [PermissionFlagsBits.ViewChannel],
  };
  const guild = buildGuild({
    channels: [buildTextChannel({ id: CHANNEL_ID, permissionsBySubject })],
    members: fixture.memberMissing === true ? [] : [{ id: presser }],
  });

  const deleteWhere = vi.fn(async () =>
    fixture.repoFails === true
      ? err(databaseErrorFrom(new Error('boom'), { operation: 'test' }))
      : ok(fixture.deleted ?? [subscription()]),
  );
  const { bot, logger } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    connectionManager: { isDisabled: () => undefined },
    getRepos: () =>
      fixture.reposMissing === true ? undefined : { feedSubscription: { deleteWhere } },
  });

  const sink = newInteractionSink();
  const interaction = buildButtonInteraction({
    customId: fixture.customId ?? `feed_clear_confirm|${CHANNEL_ID}|${INVOKER_ID}`,
    userId: presser,
    guild,
    sink,
  });

  return { bot, interaction, sink, deleteWhere, logger };
};

/** The last content the handler wrote onto the prompt message. */
const finalContent = (sink: ReturnType<typeof newInteractionSink>): string =>
  sink.editReplies.at(-1)?.content ?? '';

describe('feed_clear_confirm button handler', () => {
  it('clears the channel and reports what it removed', async () => {
    const { bot, interaction, sink, deleteWhere } = build({
      deleted: [subscription({ account: 'alpha' }), subscription({ account: 'beta' })],
    });

    await new FeedClearConfirm().execute(interaction, bot);

    expect(deleteWhere).toHaveBeenCalledWith({ channelId: CHANNEL_ID });
    const content = finalContent(sink);
    expect(content).toContain('replies:feed.unsubscribed');
    expect(content).toContain('fake @alpha');
    expect(content).toContain('fake @beta');
    expect(content).toContain('"count":2');
  });

  it('acknowledges and disarms in one request, before touching the database', async () => {
    // A read, a delete and a rendered reply do not reliably fit inside
    // Discord's three-second window for an unacknowledged component —
    // and taking the buttons away at acknowledgement time means no later
    // failure can leave them live for a second click.
    const { bot, interaction, sink } = build();

    await new FeedClearConfirm().execute(interaction, bot);

    expect(sink.updates).toEqual([{ components: [] }]);
    expect(sink.deferUpdates).toHaveLength(0);
  });

  it('records the removal in the operator log', async () => {
    // The deletion has already committed and the reply is losable, so
    // the log is the durable record of what a member cleared.
    const { bot, interaction, logger } = build({ deleted: [subscription({ account: 'alpha' })] });

    await new FeedClearConfirm().execute(interaction, bot);

    const logged = logger.info.mock.calls.flat().join(' ');
    expect(logged).toContain('feed.subscriptions_removed');
    expect(logged).toContain('fake @alpha');
  });

  it('refuses a presser who is not the member who was asked', async () => {
    // Defence in depth: the prompt is ephemeral, so this is unreachable
    // through Discord — but the deletion must not rest on that alone.
    const { bot, interaction, sink, deleteWhere } = build({ pressedBy: STRANGER_ID });

    await new FeedClearConfirm().execute(interaction, bot);

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(sink.replies[0]).toEqual({
      content: 'replies:feed.clear_not_invoker',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('leaves the prompt standing when a stranger presses it', async () => {
    // The member who was asked has not answered yet, so their buttons
    // must survive someone else's click.
    const { bot, interaction, sink } = build({ pressedBy: STRANGER_ID });

    await new FeedClearConfirm().execute(interaction, bot);

    expect(sink.updates).toHaveLength(0);
    expect(sink.editReplies).toHaveLength(0);
  });

  it('retires a customId that carries no scope instead of guessing a channel', async () => {
    // An id from an older deployment names no channel, so there is
    // nothing to clear and nothing to retry — the prompt is dead.
    const { bot, interaction, sink, deleteWhere } = build({ customId: 'feed_clear_confirm' });

    await new FeedClearConfirm().execute(interaction, bot);

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(sink.updates[0]).toEqual({
      content: 'replies:feed.clear_stale',
      components: [],
    });
  });

  it('re-checks visibility, refusing a presser who has since lost access', async () => {
    const { bot, interaction, sink, deleteWhere } = build({ permissions: [] });

    await new FeedClearConfirm().execute(interaction, bot);

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(finalContent(sink)).toContain('replies:feed.invoker_cannot_view');
  });

  it('records a denial at the click, which the prompt had already passed', async () => {
    // The member cleared this same gate when the prompt was built, so a
    // refusal here means something changed in between — the one denial
    // in the flow an operator wants to see.
    const { bot, interaction, logger } = build({ permissions: [] });

    await new FeedClearConfirm().execute(interaction, bot);

    const logged = logger.info.mock.calls.flat().join(' ');
    expect(logged).toContain('feed.clear_denied');
    expect(logged).toContain('not_visible');
  });

  it('refuses rather than deletes when permissions cannot be resolved', async () => {
    const { bot, interaction, sink, deleteWhere } = build({ memberMissing: true });

    await new FeedClearConfirm().execute(interaction, bot);

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(finalContent(sink)).toContain('replies:feed.invoker_permissions_unknown');
  });

  it('says the database is unreachable rather than deleting blind', async () => {
    const { bot, interaction, sink, deleteWhere } = build({ reposMissing: true });

    await new FeedClearConfirm().execute(interaction, bot);

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(finalContent(sink)).toContain('errors:db.not_found');
  });

  it('reports an empty channel plainly when someone else cleared it first', async () => {
    // Nothing was lost between the prompt and the click, so the honest
    // answer is the current state rather than a failure.
    const { bot, interaction, sink } = build({ deleted: [] });

    await new FeedClearConfirm().execute(interaction, bot);

    const content = finalContent(sink);
    expect(content).toContain('replies:feed.unsubscribed_none');
    expect(content).toContain(`<#${CHANNEL_ID}>`);
  });

  it('falls back to the traced failure copy when the deletion refuses', async () => {
    const { bot, interaction, sink } = build({ repoFails: true });

    await new FeedClearConfirm().execute(interaction, bot);

    const content = finalContent(sink);
    expect(content).toContain('replies:feed.failed');
    expect(content).toContain('traceId');
  });
});
