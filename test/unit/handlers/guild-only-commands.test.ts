/**
 * Commands that read guild state are hidden in DMs, where they could
 * only fail.
 */
import { describe, expect, it } from 'vitest';

import '../../../src/handlers/commands';
import { COMMAND_REGISTRY } from '../../../src/handlers/commands/registry.generated';

const GUILD_ONLY = [
  'activity',
  'ai',
  'archive',
  'ban_user',
  'change_avatar',
  'feed',
  'gay',
  'giveaway',
  'level_detail',
  'reply',
  'role',
  'roll_call',
  'talk',
  'thread',
  'traffic',
] as const satisfies readonly (keyof typeof COMMAND_REGISTRY)[];

describe('guild-only commands', () => {
  it.each(GUILD_ONLY)('%s is not offered in DMs', (name) => {
    expect(new COMMAND_REGISTRY[name]().config.guildOnly).toBe(true);
  });
});
