import { Collection, type Guild, type MessageReaction, type User } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { countEligibleVotes } from '../../../../src/application/guild-settings/vote';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const page = (users: readonly { id: string; bot?: boolean }[]) =>
  new Collection(users.map((u) => [u.id, { bot: false, ...u } as User]));
const fixture = (pages: ReturnType<typeof page>[]) => {
  const users = vi.fn();
  for (const value of pages) users.mockResolvedValueOnce(value);
  const members = vi.fn(async ({ user }: { user: string }) =>
    buildGuildMember({ id: user, roleIds: user.startsWith('eligible') ? ['voter'] : [] }),
  );
  return {
    reaction: { users: { fetch: users } } as unknown as Pick<MessageReaction, 'users'>,
    guild: { members: { fetch: members } } as unknown as Pick<Guild, 'members'>,
    users,
    members,
  };
};
describe('eligible moderation voters', () => {
  it('excludes bots, departed members and revoked roles using fresh membership', async () => {
    const f = fixture([
      page([{ id: 'eligible1' }, { id: 'bot', bot: true }, { id: 'departed' }, { id: 'revoked' }]),
    ]);
    f.members.mockImplementation(async ({ user }) => {
      if (user === 'departed') throw { code: 10007 };
      return buildGuildMember({ id: user, roleIds: user === 'eligible1' ? ['voter'] : [] });
    });
    expect(await countEligibleVotes(f.reaction, f.guild, ['voter'], 5)).toBe(1);
    expect(f.members).toHaveBeenCalledWith({ user: 'revoked', force: true });
    expect(f.members).not.toHaveBeenCalledWith({ user: 'bot', force: true });
  });
  it('counts any current human when no role restriction is configured', async () => {
    const f = fixture([page([{ id: 'human1' }, { id: 'human2' }, { id: 'bot', bot: true }])]);
    expect(await countEligibleVotes(f.reaction, f.guild, [], 5)).toBe(2);
  });
  it('fetches later reaction pages without counting repeated users', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `other${i}` }));
    const f = fixture([
      page(first),
      page([{ id: 'other99' }, { id: 'eligible1' }, { id: 'eligible2' }]),
    ]);
    expect(await countEligibleVotes(f.reaction, f.guild, ['voter'], 2)).toBe(2);
    expect(f.users).toHaveBeenNthCalledWith(2, { limit: 100, after: 'other99' });
    expect(f.members.mock.calls.filter(([arg]) => arg.user === 'other99')).toHaveLength(1);
  });
  it('does not turn a membership outage into a successful vote', async () => {
    const f = fixture([page([{ id: 'eligible1' }])]);
    f.members.mockRejectedValue(new Error('network unavailable'));
    await expect(countEligibleVotes(f.reaction, f.guild, ['voter'], 2)).rejects.toThrow(
      'network unavailable',
    );
  });
  it('stops scanning when the required vote count is reached', async () => {
    const f = fixture([page([{ id: 'eligible1' }, { id: 'eligible2' }, { id: 'eligible3' }])]);
    expect(await countEligibleVotes(f.reaction, f.guild, ['voter'], 2)).toBe(2);
    expect(f.members).toHaveBeenCalledTimes(2);
  });
});
