import { vi } from 'vitest';
import { PermissionFlagsBits, type Message } from 'discord.js';
import { Types } from 'mongoose';

import { ok } from '../../../../src/core/result';
import { FeedPlatformRegistry, type FeedPlatform } from '../../../../src/infra/social-feed';
import type { FeedSubscriptionRepo } from '../../../../src/persistence/repositories';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import {
  feedPanelSessions,
  type FeedPanelSession,
} from '../../../../src/handlers/feed-panel/session';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';
import type { newInteractionSink } from '../../../fixtures/discord/interaction-builder';

type FeedFilterDraft = Extract<FeedPanelSession['draft'], { kind: 'filter' }>;

export const actor = {
  applicationId: 'app-1',
  guildId: 'g-1',
  userId: 'u-1',
  messageId: 'reply-1',
};
export const panelMessage = (id = actor.messageId): Message =>
  ({ id, applicationId: actor.applicationId }) as Message;
export const message = panelMessage();

export interface PanelComponent {
  readonly custom_id?: string;
  readonly disabled?: boolean;
  readonly options?: readonly {
    value: string;
    default?: boolean;
    label: string;
    description?: string;
  }[];
  readonly components?: readonly PanelComponent[];
}

export const panelComponents = (
  payload: { readonly components?: readonly unknown[] } | undefined,
): PanelComponent[] => {
  const rows = JSON.parse(JSON.stringify(payload?.components ?? [])) as PanelComponent[];
  return rows.flatMap((row) => row.components ?? []);
};

export const panelContent = (sink: ReturnType<typeof newInteractionSink>): string =>
  [...sink.replies, ...sink.editReplies, ...sink.followUps]
    .map((entry) => entry.content ?? '')
    .join('\n');

export const storedSubscription = (
  overrides: Partial<FeedSubscriptionDoc> = {},
): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform: 'x',
  account: 'someone',
  channel_id: 'c-1',
  created_by: 'u-1',
  created_at: 1700000000000,
  filter: { media: 'any', keyword: 'old' },
  last_seen_id: '41',
  last_seen_timestamp: 1700000000,
  seen_ids: ['41'],
  ...overrides,
});

export const buildPanel = (
  options: {
    platformId?: string;
    existing?: FeedSubscriptionDoc;
    platform?: Partial<FeedPlatform>;
    draft?: Partial<FeedFilterDraft>;
  } = {},
) => {
  const permissions: Record<string, readonly bigint[]> = {
    'u-1': [PermissionFlagsBits.ViewChannel],
    'bot-1': [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ],
  };
  const channel = buildTextChannel({ id: 'c-1', permissionsBySubject: permissions });
  const guild = buildGuild({
    id: 'g-1',
    channels: [channel],
    members: [{ id: 'u-1' }],
    me: { id: 'bot-1' },
  });
  const fake = buildFakeFeedPlatform({
    id: options.platformId ?? 'x',
    posts: [buildFeedPost({ id: '42' })],
  });
  const normalizeAccount = vi.fn(fake.platform.normalizeAccount);
  const platform = {
    ...fake.platform,
    defaultMediaFilter: 'any' as const,
    normalizeAccount,
    ...options.platform,
  };
  const find = vi.fn<FeedSubscriptionRepo['find']>(async () => ok(options.existing));
  const upsert = vi.fn<FeedSubscriptionRepo['upsert']>(async () =>
    ok({ doc: storedSubscription(), created: !options.existing }),
  );
  const getRepos = vi.fn(() => ({ feedSubscription: { find, upsert } }));
  const { bot, logger } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    feedPlatformRegistry: new FeedPlatformRegistry([platform]),
    getRepos,
    connectionManager: { isDisabled: () => undefined },
  });
  const sessions = feedPanelSessions(bot);
  const session = sessions.open(actor, {
    kind: 'filter',
    platformId: platform.id,
    accounts: ['someone'],
    channelId: 'c-1',
    filter: { media: 'any' },
    ...options.draft,
  });
  session.messageId = message.id;
  return {
    bot,
    logger,
    guild,
    permissions,
    sessions,
    session,
    find,
    upsert,
    getRepos,
    platform,
    normalizeAccount,
    fetchTimeline: fake.fetchTimeline,
  };
};
