import { describe, expect, it } from 'vitest';
import {
  normalizeMessage,
  mergeSnapshot,
  contentHash,
  emojiKey,
} from '../../../../src/core/archive/normalize';
import { ArchivePolicySchema, evaluatePolicy } from '../../../../src/core/archive/policy';
import { checkArchiveCapacity } from '../../../../src/core/archive/capacity';
const context = {
  guildId: '1',
  observedAt: 1700000000000,
  source: 'history' as const,
  channelName: 'general',
};
const raw = {
  id: '3',
  channel_id: '2',
  author: { id: '4', username: 'Alice' },
  timestamp: '2023-11-14T22:13:20.000Z',
  content: 'hello',
};
describe('Archive display contract', () => {
  it('distinguishes omitted fields from authoritative emptiness in partial updates', () => {
    const stored = normalizeMessage(
      { ...raw, embeds: [{ title: 'notice' }], attachments: [{ id: '5', filename: 'file' }] },
      context,
    );
    const partial = normalizeMessage(
      { id: '3', channel_id: '2', content: '' },
      { ...context, source: 'gateway' },
    );
    const merged = mergeSnapshot(stored, partial);
    expect(merged.content).toBe('');
    expect(merged.attachments).toEqual(stored.attachments);
    expect(merged.presence.attachments).toBe('present');
    expect(merged.authorKind).toBe('human');
    expect(
      mergeSnapshot(stored, normalizeMessage({ ...raw, attachments: [] }, context)).attachments,
    ).toEqual([]);
  });
  it('removes SDK secrets, binary presentation and execution payloads at every supported nesting', () => {
    const value = normalizeMessage(
      {
        ...raw,
        components: [
          {
            type: 17,
            components: [{ type: 2, label: 'Go', custom_id: 'secret', url: 'https://example.com' }],
          },
        ],
        attachments: [
          {
            id: '5',
            filename: 'SPOILER_a',
            waveform: 'binary',
            url: 'https://cdn.discordapp.com/x',
          },
        ],
        interaction: { token: 'secret' },
        poll: {
          question: { text: 'When?' },
          answers: [{ answer_id: 1, poll_media: { text: 'Today' } }],
          results: { is_finalized: true, answer_counts: [{ id: 1, count: 4 }] },
        },
      },
      context,
    );
    expect(JSON.stringify(value)).not.toContain('secret');
    expect(JSON.stringify(value)).not.toContain('binary');
    expect(value.attachments?.[0]?.spoiler).toBe(true);
    expect(value.poll?.question).toEqual({ text: 'When?' });
  });
  it('ignores signed CDN URL refresh and membership changes in content hashes', () => {
    const first = normalizeMessage(
      {
        ...raw,
        attachments: [
          {
            id: '5',
            filename: 'a',
            url: 'https://cdn.discordapp.com/attachments/a?ex=1&is=2&hm=3',
          },
        ],
      },
      context,
    );
    const second = normalizeMessage(
      {
        ...raw,
        attachments: [
          {
            id: '5',
            filename: 'a',
            url: 'https://cdn.discordapp.com/attachments/a?ex=9&is=8&hm=7',
          },
        ],
        reactions: [{ emoji: { name: '👍' }, count: 8 }],
      },
      { ...context, observedAt: context.observedAt + 1 },
    );
    expect(first.contentHash).toBe(second.contentHash);
    expect(contentHash({ ...first, content: 'edited' })).not.toBe(first.contentHash);
    expect(emojiKey({ id: '99', name: 'renamed' })).toBe('custom:99');
    expect(emojiKey({ name: '👍' })).toBe('unicode:👍');
  });
  it('preserves deletion evidence while enriching late snapshots', () => {
    const stored = {
      ...normalizeMessage(raw, context),
      deletion: { deletedAt: context.observedAt, source: 'gateway' },
    };
    expect(mergeSnapshot(stored, normalizeMessage(raw, context)).deletion).toEqual(stored.deletion);
  });
});
describe('Archive admission policy', () => {
  const policy = ArchivePolicySchema.parse({ guildIds: ['1'] });
  it('admits all human structured messages and retains unknown legacy rows', () => {
    expect(
      evaluatePolicy(
        normalizeMessage({ ...raw, content: '', attachments: [{ id: '5' }] }, context),
        policy,
      ).admitted,
    ).toBe(true);
    expect(evaluatePolicy({ guildId: '1', authorKind: 'unknown' }, policy)).toMatchObject({
      admitted: true,
      unresolved: true,
    });
  });
  it('empty lists deny known bot and webhook sources, with webhook precedence', () => {
    expect(
      evaluatePolicy(normalizeMessage({ ...raw, author: { id: '4', bot: true } }, context), policy)
        .admitted,
    ).toBe(false);
    expect(
      evaluatePolicy(normalizeMessage({ ...raw, webhook_id: '9' }, context), policy).reason,
    ).toBe('webhook-not-allowlisted');
  });
  it('matches ordered rules, inherited parent scope and structure-only messages', () => {
    const scoped = ArchivePolicySchema.parse({
      guildIds: ['1'],
      bots: [
        { ruleId: 'deny', sourceId: '4', action: 'exclude', contains: 'spam' },
        { ruleId: 'allow', sourceId: '4', channelIds: ['20'], structures: ['poll'] },
      ],
    });
    const snapshot = normalizeMessage(
      { ...raw, author: { id: '4', bot: true }, poll: { question: { text: 'hi' } } },
      { ...context, parentId: '20' },
    );
    expect(evaluatePolicy(snapshot, scoped)).toMatchObject({ admitted: true, ruleId: 'allow' });
    expect(evaluatePolicy({ ...snapshot, content: 'spam' }, scoped)).toMatchObject({
      admitted: false,
      ruleId: 'deny',
    });
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
