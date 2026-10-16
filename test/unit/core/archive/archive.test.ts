import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  archiveAuthorKind,
  fillSnapshot,
  isStaleObservation,
  mergeSnapshot,
  normalizeMessage,
  reactionKey,
  reactionStreamKey,
  snowflakeTimestamp,
  unsignedDiscordUrl,
} from '../../../../src/core/archive/normalize';
import {
  ArchivePolicySchema,
  INTERACTION_RECORD_EXCLUDED_FIELDS,
  applyPolicyDecision,
  evaluatePolicy,
  policyIgnoresContent,
} from '../../../../src/core/archive/policy';
import {
  ARCHIVE_EDIT_HISTORY_LIMIT,
  type ArchiveMessage,
  type ArchiveSnapshot,
} from '../../../../src/core/archive/types';
import { checkArchiveCapacity } from '../../../../src/core/archive/capacity';
import { messageSchema } from '../../../../src/persistence/schemas/message.schema';

const context = { observedAt: 1700000000000 };
const raw = {
  id: '3',
  channel_id: '2',
  author: { id: '4', username: 'alice', global_name: 'Alice', bot: false },
  timestamp: '2023-11-14T22:13:20.000Z',
  edited_timestamp: null,
  content: 'hello',
};
/** Every field the normalizer produces, from a REST message that uses all of them. */
const fullRaw = {
  ...raw,
  type: 19,
  flags: 4,
  webhook_id: '50',
  application_id: '51',
  interaction_metadata: {
    id: '52',
    type: 2,
    user: { id: '4', username: 'alice', global_name: null },
    target_user: { id: '53' },
    target_message_id: '54',
    interacted_message_id: '55',
    authorizing_integration_owners: { '0': '1' },
  },
  interaction: { name: 'deprecated', token: 'secret' },
  attachments: [
    {
      id: '5',
      filename: 'SPOILER_a.png',
      title: 'a b.png',
      description: 'alt',
      content_type: 'image/png',
      size: 10,
      width: 2,
      height: 3,
      duration_secs: 1.5,
      flags: 4,
      waveform: 'binary',
      url: 'https://cdn.discordapp.com/attachments/2/5/SPOILER_a.png?ex=1&is=2&hm=3&',
      proxy_url: 'https://media.discordapp.net/attachments/2/5/SPOILER_a.png?ex=1&is=2&hm=3',
    },
  ],
  sticker_items: [{ id: '6', name: 'wave', format_type: 1 }],
  embeds: [
    {
      type: 'rich',
      title: 't',
      description: 'd',
      url: 'https://cdn.discordapp.com/attachments/2/9/page.png?ex=1&is=2&hm=3',
      color: 1,
      timestamp: '2023-11-14T22:13:20.000Z',
      author: {
        name: 'n',
        url: 'https://media.discordapp.net/a.png?ex=1&is=2&hm=3',
        icon_url: 'x',
      },
      footer: { text: 'f', icon_url: 'x' },
      provider: { name: 'YouTube', url: 'https://youtube.com' },
      image: { url: 'https://media.discordapp.net/i.png?ex=1&is=2&hm=3', width: 1, height: 1 },
      thumbnail: { url: 'https://example.com/t.png', width: 1, height: 1, proxy_url: 'x' },
      video: { url: 'https://example.com/v.mp4', width: 1, height: 1 },
      fields: [{ name: 'k', value: 'v', inline: true }],
    },
  ],
  components: [
    {
      type: 17,
      components: [
        { type: 2, label: 'Go', custom_id: 'secret', url: 'https://example.com' },
        {
          type: 12,
          items: [
            {
              description: 'gallery',
              media: { url: 'https://cdn.discordapp.com/attachments/2/8/g.png?ex=1&is=2&hm=3' },
            },
          ],
        },
        {
          type: 9,
          accessory: {
            type: 11,
            media: { url: 'https://media.discordapp.net/attachments/2/7/t.png?ex=1&is=2&hm=3' },
          },
        },
      ],
    },
  ],
  reactions: [
    { emoji: { id: null, name: '👍' }, count: 3, count_details: { normal: 2, burst: 1 } },
    { emoji: { id: '7', name: 'custom', animated: true }, count: 1, me: true },
  ],
  mentions: [{ id: '8', username: 'bob' }],
  mention_roles: ['9'],
  mention_channels: [{ id: '10', guild_id: '1' }],
  mention_everyone: false,
  message_reference: { guild_id: '1', channel_id: '2', message_id: '11', type: 0 },
  referenced_message: { id: '11', author: { id: '12' } },
  thread: { id: '13', name: 'topic', type: 11, parent_id: '2' },
  poll: {
    question: { text: 'When?' },
    answers: [{ answer_id: 1, poll_media: { text: 'Today', emoji: { name: '📅' } } }],
    expiry: '2023-11-15T22:13:20.000Z',
    allow_multiselect: false,
    results: { is_finalized: true, answer_counts: [{ id: 1, count: 4, me_voted: false }] },
  },
  message_snapshots: [
    {
      message: {
        type: 0,
        flags: 0,
        content: 'forwarded',
        timestamp: '2023-11-14T22:13:20.000Z',
        edited_timestamp: null,
        attachments: [],
        sticker_items: [],
        embeds: [],
        components: [],
      },
    },
  ],
};
const MessageModel = mongoose.model('ArchiveContractMessage', messageSchema.clone());
const policy = ArchivePolicySchema.parse({ guildIds: ['1'] });
const location = { guildId: '1' };

describe('Archive normalization contract', () => {
  it('produces documents the stored message schema accepts without dropping a field', () => {
    for (const snapshot of [
      normalizeMessage(fullRaw, context),
      normalizeMessage(raw, context),
      normalizeMessage({ id: '3', channel_id: '2' }, context),
    ]) {
      const document = new MessageModel(snapshot);
      expect(document.validateSync()).toBeUndefined();
      expect(
        document.toObject({
          flattenMaps: true,
          minimize: false,
          versionKey: false,
          depopulate: true,
        }),
      ).toEqual(snapshot);
    }
  });
  it('round-trips stored documents with history, policy and backup metadata', () => {
    const edited = mergeSnapshot(
      mergeSnapshot({}, normalizeMessage(fullRaw, context)),
      normalizeMessage(
        { ...fullRaw, content: 'edited', edited_timestamp: '2023-11-15T00:00:00.000Z' },
        { observedAt: context.observedAt + 1 },
      ),
    );
    const documents: ArchiveMessage[] = [
      {
        ...edited,
        policy: { version: '1', reason: 'rule-include', ruleId: 'keep' },
        reactionGenerations: { '7:0': { generation: 'g', observedAt: 1, complete: true } },
        reactionsFreshAt: 2,
        reactionsStaleAt: 3,
        deletedAt: 4,
        editHistoryDropped: 1,
      },
      {
        ...normalizeMessage({ id: '3', channel_id: '2', type: 20 }, context),
        excludedFields: [...INTERACTION_RECORD_EXCLUDED_FIELDS],
        policy: { version: '1', reason: 'interaction-record' },
      },
    ];
    expect(documents[0]?.editHistory).toHaveLength(1);
    for (const stored of documents) {
      const document = new MessageModel(stored);
      expect(document.validateSync()).toBeUndefined();
      expect(
        document.toObject({
          flattenMaps: true,
          minimize: false,
          versionKey: false,
          depopulate: true,
        }),
      ).toEqual(stored);
    }
  });
  it('names fields after discord.js and drops secrets, binaries and the deprecated interaction', () => {
    const value = normalizeMessage(fullRaw, context);
    expect(value).toMatchObject({
      _id: '3',
      schemaVersion: 3,
      channelId: '2',
      author: { id: '4', username: 'alice', globalName: 'Alice', bot: false },
      createdTimestamp: Date.parse(raw.timestamp),
      editedTimestamp: null,
      interactionMetadata: {
        id: '52',
        type: 2,
        user: { id: '4', username: 'alice', globalName: null },
        targetUserId: '53',
        targetMessageId: '54',
        interactedMessageId: '55',
      },
      stickers: [{ id: '6', name: 'wave', format: 1 }],
      reactions: [
        { emoji: { name: '👍' }, count: 3, countDetails: { normal: 2, burst: 1 } },
        { emoji: { id: '7', name: 'custom', animated: true }, count: 1 },
      ],
      mentions: { users: ['8'], roles: ['9'], channels: ['10'], everyone: false },
      thread: { id: '13', name: 'topic', type: 11 },
      poll: {
        question: { text: 'When?' },
        answers: [{ id: 1, text: 'Today', emoji: { name: '📅' }, voteCount: 4 }],
        resultsFinalized: true,
        allowMultiselect: false,
      },
      messageSnapshots: [{ content: 'forwarded', editedTimestamp: null }],
    });
    const serialized = JSON.stringify(value);
    for (const leaked of ['secret', 'binary', 'deprecated', 'proxy', 'icon_url', 'me_voted'])
      expect(serialized).not.toContain(leaked);
    expect(value.attachments?.[0]).not.toHaveProperty('spoiler');
    expect(value.thread).not.toHaveProperty('parentId');
  });
  it('stores attachment and media URLs without the expiring signature', () => {
    const value = normalizeMessage(fullRaw, context);
    expect(value.attachments?.[0]?.url).toBe(
      'https://cdn.discordapp.com/attachments/2/5/SPOILER_a.png',
    );
    expect(value.embeds?.[0]).toMatchObject({
      url: 'https://cdn.discordapp.com/attachments/2/9/page.png',
      author: { url: 'https://media.discordapp.net/a.png' },
      image: { url: 'https://media.discordapp.net/i.png' },
    });
    expect(serialized(value.components)).toContain(
      'https://cdn.discordapp.com/attachments/2/8/g.png"',
    );
    expect(serialized(value.components)).toContain(
      'https://media.discordapp.net/attachments/2/7/t.png"',
    );
    expect(serialized(value)).not.toMatch(/[?&](ex|is|hm)=/);
    expect(unsignedDiscordUrl('https://example.com/a?ex=1')).toBe('https://example.com/a?ex=1');
    expect(unsignedDiscordUrl('not a url')).toBe('not a url');
  });
  it('records the replied-to author only while Discord still provides it', () => {
    expect(normalizeMessage(fullRaw, context).reference).toEqual({
      guildId: '1',
      channelId: '2',
      messageId: '11',
      type: 0,
      authorId: '12',
    });
    const deleted = normalizeMessage({ ...fullRaw, referenced_message: null }, context);
    expect(deleted.reference).toEqual({ guildId: '1', channelId: '2', messageId: '11', type: 0 });
    expect(deleted.reference).not.toHaveProperty('authorId');
  });
  it('keeps unobserved fields absent and derives the creation time from the ID', () => {
    const partial = normalizeMessage({ id: '1180000000000000000', channel_id: '2' }, context);
    expect(Object.keys(partial).sort()).toEqual(
      ['_id', 'channelId', 'createdTimestamp', 'observedAt', 'schemaVersion'].sort(),
    );
    expect(partial.createdTimestamp).toBe(snowflakeTimestamp('1180000000000000000'));
  });
  it('keys reactions by custom emoji ID or Unicode emoji and classifies authors', () => {
    expect(reactionKey({ id: '99', name: 'renamed' })).toBe('99');
    expect(reactionKey({ id: null, name: '👍' })).toBe('👍');
    expect(reactionKey({ id: null, name: null })).toBeUndefined();
    expect(reactionStreamKey('99', 1)).toBe('99:1');
    expect(archiveAuthorKind({ author: { id: '1' } })).toBe('human');
    expect(archiveAuthorKind({ author: { id: '1', bot: true } })).toBe('bot');
    expect(archiveAuthorKind({ author: { id: '1', bot: true }, webhookId: '2' })).toBe('webhook');
    expect(archiveAuthorKind({})).toBe('unknown');
  });
});

const serialized = (value: unknown): string => JSON.stringify(value);
const created = Date.parse(raw.timestamp);
/** An observation edited `edited` ms after creation (`null`: never edited). */
const observation = (
  content: string,
  edited: number | null,
  observedAt: number,
  extra: Record<string, unknown> = {},
): ArchiveSnapshot =>
  normalizeMessage(
    {
      ...raw,
      content,
      edited_timestamp: edited === null ? null : new Date(created + edited).toISOString(),
      attachments: [],
      embeds: [],
      ...extra,
    },
    { observedAt },
  );

describe('Archive observation merge', () => {
  it('merges only the fields a partial observation carries', () => {
    const stored = mergeSnapshot({}, observation('hello', null, 1, { attachments: [{ id: '5' }] }));
    const partial = normalizeMessage({ id: '3', channel_id: '2', content: '' }, { observedAt: 2 });
    const merged = mergeSnapshot(stored, partial);
    expect(merged.content).toBe('');
    expect(merged.attachments).toEqual([{ id: '5' }]);
    expect(merged.author).toEqual(stored.author);
    expect(merged.editHistory).toBeUndefined();
    expect(mergeSnapshot(stored, observation('hello', null, 2)).attachments).toEqual([]);
  });
  it('merges references per field and keeps poll results a later observation lacks', () => {
    const stored = mergeSnapshot(
      {},
      observation('reply', null, 1, {
        message_reference: { guild_id: '1', channel_id: '2', message_id: '11', type: 0 },
        referenced_message: { id: '11', author: { id: '12' } },
        poll: {
          question: { text: 'Q' },
          answers: [{ answer_id: 1, poll_media: { text: 'A' } }],
          results: { is_finalized: false, answer_counts: [{ id: 1, count: 4 }] },
        },
      }),
    );
    const later = mergeSnapshot(
      stored,
      observation('reply', null, 2, {
        // The original was deleted, and this payload carries no poll results.
        message_reference: { guild_id: '1', channel_id: '2', message_id: '11', type: 0 },
        referenced_message: null,
        poll: { question: { text: 'Q' }, answers: [{ answer_id: 1, poll_media: { text: 'A' } }] },
      }),
    );
    expect(later.reference?.authorId).toBe('12');
    expect(later.poll).toMatchObject({
      resultsFinalized: false,
      answers: [{ id: 1, text: 'A', voteCount: 4 }],
    });
    const finished = mergeSnapshot(
      later,
      observation('reply', null, 3, {
        poll: {
          question: { text: 'Q' },
          answers: [{ answer_id: 1, poll_media: { text: 'A' } }],
          results: { is_finalized: true, answer_counts: [{ id: 1, count: 5 }] },
        },
      }),
    );
    expect(finished.poll).toMatchObject({ resultsFinalized: true, answers: [{ voteCount: 5 }] });
  });
  it('lets an older observation only fill fields the stored document lacks', () => {
    const tombstone = {
      _id: '3',
      schemaVersion: 3 as const,
      channelId: '2',
      createdTimestamp: created,
      observedAt: 50,
      deletedAt: 40,
    };
    const filled = fillSnapshot(tombstone, observation('hello', null, 10));
    expect(filled).toMatchObject({ content: 'hello', deletedAt: 40, observedAt: 50 });
    expect(filled?.author).toEqual({ id: '4', username: 'alice', globalName: 'Alice', bot: false });
    expect(filled).not.toHaveProperty('editHistory');
    // Nothing is replaced, so a second older observation has nothing to add.
    expect(fillSnapshot(filled!, observation('older', 5, 5))).toBeUndefined();
    expect(filled?.content).toBe('hello');
  });
  it('moves the previous content into the edit history only on a real edit', () => {
    const original = mergeSnapshot(
      {},
      observation('v1', null, 1, { embeds: [{ title: 'e' }], components: [] }),
    );
    const edited = mergeSnapshot(original, observation('v2', 5000, 2));
    expect(edited.content).toBe('v2');
    expect(edited.editHistory).toEqual([
      {
        editedTimestamp: null,
        observedAt: 1,
        content: 'v1',
        attachments: [],
        embeds: [{ title: 'e' }],
        components: [],
      },
    ]);
    // A link preview, poll votes or reactions keep the edit time: not an edit.
    const unfurled = mergeSnapshot(
      edited,
      observation('v2', 5000, 3, { embeds: [{ type: 'link', url: 'https://example.com' }] }),
    );
    expect(unfurled.editHistory).toHaveLength(1);
    expect(unfurled.embeds).toEqual([{ type: 'link', url: 'https://example.com' }]);
    // The same edit observed again is not recorded twice.
    expect(mergeSnapshot(unfurled, observation('v2', 5000, 4)).editHistory).toHaveLength(1);
  });
  it('keeps the newest versions and counts the dropped ones', () => {
    let stored = mergeSnapshot({}, observation('v0', null, 1));
    for (let version = 1; version <= ARCHIVE_EDIT_HISTORY_LIMIT + 2; version += 1)
      stored = mergeSnapshot(stored, observation(`v${version}`, version * 1000, version + 1));
    expect(stored.editHistory).toHaveLength(ARCHIVE_EDIT_HISTORY_LIMIT);
    // 52 edits keep the newest 50 previous versions (v2 to v51); v52 is current.
    expect(stored.editHistoryDropped).toBe(2);
    expect(stored.editHistory?.[0]?.content).toBe('v2');
    expect(stored.editHistory?.at(-1)?.content).toBe(`v${ARCHIVE_EDIT_HISTORY_LIMIT + 1}`);
  });
  it('rejects observations older than the stored content or observation', () => {
    const stored = mergeSnapshot({}, observation('v2', 5000, 10));
    expect(isStaleObservation(stored, observation('v1', null, 20))).toBe(true);
    expect(isStaleObservation(stored, observation('v3', 6000, 5))).toBe(false);
    expect(isStaleObservation(stored, observation('v2', 5000, 9))).toBe(true);
    const partial = normalizeMessage({ id: '3', channel_id: '2', content: 'x' }, { observedAt: 9 });
    expect(isStaleObservation(stored, partial)).toBe(true);
    expect(isStaleObservation(stored, { ...partial, observedAt: 11 })).toBe(false);
  });
  it('preserves deletion and drops excluded fields with their history', () => {
    const stored = {
      ...mergeSnapshot(mergeSnapshot({}, observation('v1', null, 1)), observation('v2', 5, 2)),
      deletedAt: 3,
      reactionGenerations: { 'x:0': { generation: 'g', observedAt: 1, complete: true } },
    };
    expect(mergeSnapshot(stored, observation('v2', 5, 4)).deletedAt).toBe(3);
    const record = mergeSnapshot(stored, {
      ...normalizeMessage({ id: '3', channel_id: '2', type: 0 }, { observedAt: 5 }),
      excludedFields: [...INTERACTION_RECORD_EXCLUDED_FIELDS],
    });
    for (const field of [
      'content',
      'attachments',
      'embeds',
      'editedTimestamp',
      'editHistory',
      'reactionGenerations',
    ])
      expect(record).not.toHaveProperty(field);
    expect(record.deletedAt).toBe(3);
    expect(mergeSnapshot(record, observation('v3', 6, 6))).not.toHaveProperty('excludedFields');
  });
});

describe('Archive admission policy', () => {
  const bot = { id: '4', username: 'app', bot: true };
  const interaction = { id: '9', type: 2, user: { id: '5' } };
  it('keeps human messages without a policy record and retains unknown authors', () => {
    const human = normalizeMessage({ ...raw, content: '', attachments: [{ id: '5' }] }, context);
    const decision = evaluatePolicy(human, policy, location);
    expect(decision).toEqual({ version: '1', admitted: true, reason: 'human' });
    if (!decision.admitted) throw new Error('expected admission');
    expect(applyPolicyDecision(human, decision)).not.toHaveProperty('policy');
    expect(evaluatePolicy(human, policy, { guildId: '2' }).admitted).toBe(false);
  });
  it('keeps only the identity of a message whose author is unknown', () => {
    const partial = normalizeMessage(
      { id: '3', channel_id: '2', content: 'maybe a bot', embeds: [{ title: 'x' }] },
      context,
    );
    const decision = evaluatePolicy(partial, policy, location);
    expect(decision).toEqual({ version: '1', admitted: true, reason: 'unknown-author-retained' });
    if (!decision.admitted) throw new Error('expected admission');
    expect(applyPolicyDecision(partial, decision)).toEqual({
      _id: '3',
      schemaVersion: 3,
      channelId: '2',
      createdTimestamp: partial.createdTimestamp,
      observedAt: context.observedAt,
      policy: { version: '1', reason: 'unknown-author-retained' },
    });
  });
  it('denies bot and webhook messages without an interaction when no rule matches', () => {
    expect(
      evaluatePolicy(normalizeMessage({ ...raw, author: bot }, context), policy, location),
    ).toMatchObject({ admitted: false, reason: 'bot-not-allowlisted' });
    expect(
      evaluatePolicy(normalizeMessage({ ...raw, webhook_id: '9' }, context), policy, location)
        .reason,
    ).toBe('webhook-not-allowlisted');
    // Interaction metadata alone is not enough: the author must be a bot.
    expect(
      evaluatePolicy(
        normalizeMessage({ ...raw, webhook_id: '9', interaction_metadata: interaction }, context),
        policy,
        location,
      ).reason,
    ).toBe('webhook-not-allowlisted');
  });
  it('keeps only the interaction record of an unlisted bot reply', () => {
    const reply = normalizeMessage(
      {
        ...fullRaw,
        author: bot,
        webhook_id: undefined,
        interaction_metadata: interaction,
      },
      context,
    );
    const decision = evaluatePolicy(reply, policy, location);
    expect(decision).toEqual({ version: '1', admitted: true, reason: 'interaction-record' });
    if (!decision.admitted) throw new Error('expected admission');
    const record = applyPolicyDecision(reply, decision);
    // Independent of the policy's own lists: every field a full message carries is
    // either kept by the record or listed as excluded, never both.
    const full = normalizeMessage(fullRaw, context);
    const kept = Object.keys(record).filter((key) => key !== 'excludedFields' && key !== 'policy');
    expect(kept.filter((key) => record.excludedFields?.includes(key as never))).toEqual([]);
    expect([...kept, ...(record.excludedFields ?? [])].sort()).toEqual(Object.keys(full).sort());
    expect(Object.keys(record).sort()).toEqual(
      [
        '_id',
        'schemaVersion',
        'channelId',
        'author',
        'applicationId',
        'interactionMetadata',
        'type',
        'createdTimestamp',
        'observedAt',
        'excludedFields',
        'policy',
      ].sort(),
    );
    expect(record.excludedFields).toEqual([...INTERACTION_RECORD_EXCLUDED_FIELDS]);
    expect(record.policy).toEqual({ version: '1', reason: 'interaction-record' });
    // Interaction replies may arrive through the application's webhook.
    const viaWebhook = { ...reply, webhookId: '51' };
    expect(evaluatePolicy(viaWebhook, policy, location)).toMatchObject({
      reason: 'interaction-record',
    });
  });
  it('lets an exclude rule drop even the interaction record, and include rules keep everything', () => {
    const reply = normalizeMessage(
      { ...raw, author: bot, webhook_id: '51', interaction_metadata: interaction },
      context,
    );
    const excluded = ArchivePolicySchema.parse({
      guildIds: ['1'],
      bots: [{ ruleId: 'quiet', sourceId: '4', action: 'exclude' }],
    });
    expect(evaluatePolicy(reply, excluded, location)).toMatchObject({
      admitted: false,
      ruleId: 'quiet',
    });
    const included = ArchivePolicySchema.parse({
      guildIds: ['1'],
      bots: [{ ruleId: 'keep', sourceId: '4' }],
    });
    const decision = evaluatePolicy(reply, included, location);
    expect(decision).toEqual({
      version: '1',
      admitted: true,
      reason: 'rule-include',
      ruleId: 'keep',
    });
    if (!decision.admitted) throw new Error('expected admission');
    expect(applyPolicyDecision(reply, decision)).toMatchObject({
      content: 'hello',
      policy: { version: '1', reason: 'rule-include', ruleId: 'keep' },
    });
  });
  it('matches ordered rules, inherited parent scope and structure-only messages', () => {
    const scoped = ArchivePolicySchema.parse({
      guildIds: ['1'],
      bots: [
        { ruleId: 'deny', sourceId: '4', action: 'exclude', contains: 'spam' },
        { ruleId: 'allow', sourceId: '4', channelIds: ['20'], structures: ['poll', 'snapshots'] },
      ],
    });
    const snapshot = normalizeMessage(
      {
        ...raw,
        author: bot,
        poll: { question: { text: 'hi' } },
        message_snapshots: [{ message: { content: 'x' } }],
      },
      context,
    );
    expect(evaluatePolicy(snapshot, scoped, { guildId: '1', parentId: '20' })).toMatchObject({
      admitted: true,
      ruleId: 'allow',
    });
    expect(evaluatePolicy(snapshot, scoped, location)).toMatchObject({ admitted: false });
    expect(
      evaluatePolicy({ ...snapshot, content: 'spam' }, scoped, { guildId: '1', parentId: '20' }),
    ).toMatchObject({ admitted: false, ruleId: 'deny' });
  });
  it('captures content only when some rule could keep the full message', () => {
    const botMessage = normalizeMessage({ ...raw, author: bot }, context);
    const webhookReply = normalizeMessage(
      { ...raw, author: bot, webhook_id: '9', interaction_metadata: interaction },
      context,
    );
    expect(policyIgnoresContent(botMessage, policy)).toBe(true);
    expect(policyIgnoresContent(webhookReply, policy)).toBe(true);
    expect(policyIgnoresContent(normalizeMessage(raw, context), policy)).toBe(false);
    const withBots = ArchivePolicySchema.parse({
      guildIds: ['1'],
      bots: [{ ruleId: 'keep', sourceId: '4' }],
    });
    expect(policyIgnoresContent(botMessage, withBots)).toBe(false);
    expect(policyIgnoresContent(webhookReply, withBots)).toBe(false);
    // Rules for other sources keep nothing of this one.
    const otherBot = ArchivePolicySchema.parse({
      guildIds: ['1'],
      bots: [{ ruleId: 'other', sourceId: '99' }],
      webhooks: [{ ruleId: 'feed', sourceId: '98' }],
    });
    expect(policyIgnoresContent(botMessage, otherBot)).toBe(true);
    expect(policyIgnoresContent(webhookReply, otherBot)).toBe(true);
  });
  it('rejects invalid settings and duplicate rule identifiers', () => {
    expect(() =>
      ArchivePolicySchema.parse({ guildIds: ['1'], bots: [{ ruleId: 'bad', sourceId: 'name' }] }),
    ).toThrow();
    expect(() =>
      ArchivePolicySchema.parse({
        guildIds: ['1'],
        bots: [{ ruleId: 'same', sourceId: '2' }],
        webhooks: [{ ruleId: 'same', sourceId: '3' }],
      }),
    ).toThrow();
  });
});
describe('Shared project capacity guard', () => {
  it('reserves headroom and pauses bulk without stopping affordable live writes', () => {
    const capacity = {
      projectBytes: 84_000_000_000,
      freeBytes: 40_000_000_000,
      projectedBytes: 500_000_000,
      reservedBytes: 600_000_000,
    };
    expect(checkArchiveCapacity(capacity, 'bulk').reason).toBe('backfill-paused');
    expect(checkArchiveCapacity(capacity, 'live').allowed).toBe(true);
    expect(checkArchiveCapacity({ ...capacity, freeBytes: 1_000_000_000 }, 'live').reason).toBe(
      'filesystem-space',
    );
    expect(checkArchiveCapacity({ ...capacity, projectBytes: 99_000_000_000 }, 'live').reason).toBe(
      'project-budget',
    );
  });
});
