/**
 * Channel ranking rows: a forum post carries its forum as a tag, unless the
 * caller drops it (the person dashboard's half-width channel list).
 */
import type { Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { channelRow } from '../../../../src/handlers/commands/traffic-shared/rankings';
import type { TrafficContext } from '../../../../src/handlers/commands/traffic-shared/run';

const context = {
  t: (key: string, params?: Record<string, unknown>) =>
    params?.name === undefined ? key : `#${String(params.name)}`,
  guild: { channels: { cache: new Map() } } as unknown as Guild,
} as unknown as TrafficContext;
const post = {
  channelId: 'post-1',
  name: 'weekly',
  messages: 12,
  deleted: false,
  forum: { channelId: 'forum', name: 'creations' },
};

describe('channelRow', () => {
  it('tags a forum post with its forum by default', () => {
    expect(channelRow(context, new Map(), post)).toEqual({
      name: 'weekly',
      value: 12,
      tag: '#creations',
    });
  });

  it('leaves the tag off when forum tags are disabled', () => {
    expect(channelRow(context, new Map(), post, { forumTag: false })).toEqual({
      name: 'weekly',
      value: 12,
    });
  });
});
