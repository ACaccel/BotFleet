import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveNavigationId,
  resolveArchiveNavigation,
  bindArchiveNavigationMessage,
} from '../../../../src/handlers/commands/archive/navigation';

const actor = { userId: '123', channelId: '456', guildId: '789' };
afterEach(() => vi.restoreAllMocks());
describe('archive navigation positions', () => {
  it('keeps long run IDs and nested return cursors outside Discord IDs', () => {
    const runId = 'r'.repeat(160);
    const page = {
      view: 'operation' as const,
      sequence: 90,
      returnTo: {
        view: 'changes' as const,
        category: 'reset-progress' as const,
        afterSequence: 85,
        sourceId: '12345678901234567890',
      },
    };
    const customId = archiveNavigationId(runId, actor, page);
    expect(customId.length).toBeLessThanOrEqual(100);
    expect(resolveArchiveNavigation(customId, actor)).toEqual({ runId, page });
    const resolved = resolveArchiveNavigation(customId, actor);
    resolved.page.returnTo!.afterSequence = 0;
    expect(resolveArchiveNavigation(customId, actor).page.returnTo?.afterSequence).toBe(85);
  });
  it.each(['userId', 'channelId', 'guildId'] as const)('rejects a different %s', (field) => {
    const customId = archiveNavigationId('run', actor, { view: 'summary' });
    expect(() => resolveArchiveNavigation(customId, { ...actor, [field]: '999' })).toThrow(
      'navigation_stale',
    );
  });
  it('shares published positions with current managers only in the bound message', () => {
    const customId = archiveNavigationId('run', actor, { view: 'changes', afterSequence: 9 });
    bindArchiveNavigationMessage(customId, actor.channelId, 'message', actor.guildId);
    expect(
      resolveArchiveNavigation(customId, {
        ...actor,
        userId: 'another-manager',
        messageId: 'message',
      }).page.afterSequence,
    ).toBe(9);
    expect(() =>
      resolveArchiveNavigation(customId, { ...actor, messageId: 'copied-message' }),
    ).toThrow('navigation_stale');
    expect(() =>
      resolveArchiveNavigation(customId, { ...actor, messageId: 'message', guildId: 'other' }),
    ).toThrow('navigation_stale');
  });
  it('expires view positions without reviving them or confusing menu tokens', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    const customId = archiveNavigationId('run', actor, { view: 'changes' }, 'category');
    expect(() => resolveArchiveNavigation(customId, actor)).toThrow('navigation_stale');
    now.mockReturnValue(100 + 14 * 60_000);
    expect(() => resolveArchiveNavigation(customId, actor, 'category')).toThrow('navigation_stale');
  });
  it('does not let another panel steal an already published navigation position', () => {
    const customId = archiveNavigationId('run', actor, { view: 'summary' });
    bindArchiveNavigationMessage(customId, actor.channelId, 'first', actor.guildId);
    expect(() =>
      bindArchiveNavigationMessage(customId, actor.channelId, 'second', actor.guildId),
    ).toThrow('navigation_stale');
    expect(resolveArchiveNavigation(customId, { ...actor, messageId: 'first' }).runId).toBe('run');
  });
  it('evicts old positions when the bounded cache is full', () => {
    const first = archiveNavigationId('run', actor, { view: 'summary' });
    let latest = '';
    for (let index = 0; index < 5000; index++)
      latest = archiveNavigationId('run', actor, { view: 'changes', afterSequence: index });
    expect(() => resolveArchiveNavigation(first, actor)).toThrow('navigation_stale');
    expect(resolveArchiveNavigation(latest, actor).page.afterSequence).toBe(4999);
  });
});
