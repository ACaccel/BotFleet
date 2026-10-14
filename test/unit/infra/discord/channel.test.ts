/**
 * Unit tests for {@link parentChannelIdOf} (single safe parent-id extraction)
 * and {@link ancestorChannelIdsOf} (the full parent → category ancestry walk
 * the rank model folds over). Effective-rank propagation rests on these, so
 * every branch — no parent, one level, full chain, unresolved intermediate,
 * and the cycle depth-guard — is pinned here.
 */
import { describe, expect, it } from 'vitest';
import type { Channel } from 'discord.js';

import { ancestorChannelIdsOf, parentChannelIdOf } from '../../../../src/infra/discord';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';

const ch = (parentId: string | null): Channel => buildTextChannel({ id: 'c', parentId });

describe('parentChannelIdOf', () => {
  it('returns null for null or undefined input', () => {
    expect(parentChannelIdOf(null)).toBeNull();
    expect(parentChannelIdOf(undefined)).toBeNull();
  });

  it("returns a thread's parent id", () => {
    expect(parentChannelIdOf(ch('forum-1'))).toBe('forum-1');
  });

  it('returns null for a top-level channel (parentId null)', () => {
    expect(parentChannelIdOf(ch(null))).toBeNull();
  });

  it('returns null for a channel type that has no parentId property', () => {
    expect(parentChannelIdOf({ id: 'c1' } as unknown as Channel)).toBeNull();
  });
});

describe('ancestorChannelIdsOf', () => {
  it('returns [] when the channel has no parent', () => {
    expect(ancestorChannelIdsOf(ch(null))).toEqual([]);
    expect(ancestorChannelIdsOf(null)).toEqual([]);
  });

  it('returns the immediate parent only when no lookup is supplied', () => {
    expect(ancestorChannelIdsOf(ch('forum'))).toEqual(['forum']);
  });

  it('climbs the full chain thread → channel → category via the lookup', () => {
    const lookup = new Map<string, Channel>([
      ['channel', ch('cat')],
      ['cat', ch(null)],
    ]);
    expect(ancestorChannelIdsOf(ch('channel'), lookup)).toEqual(['channel', 'cat']);
  });

  it('stops at one level when an intermediate ancestor is not resolvable', () => {
    expect(ancestorChannelIdsOf(ch('channel'), new Map<string, Channel>())).toEqual(['channel']);
  });

  it('caps depth to guard against a cycle', () => {
    const ancestors = ancestorChannelIdsOf(ch('loop'), { get: () => ch('loop') });
    expect(ancestors).toHaveLength(8);
    expect(ancestors.every((id) => id === 'loop')).toBe(true);
  });
});
