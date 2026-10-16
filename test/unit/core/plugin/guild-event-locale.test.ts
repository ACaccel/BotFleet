import { describe, expect, it } from 'vitest';
import { GuildLocaleContext, I18NextTranslator } from '../../../../src/core/i18n';
import { EventDispatcher } from '../../../../src/core/plugin/event-dispatcher';
import { guildIdForEvent, guildIdForInteraction } from '../../../../src/core/plugin/event-guild';
import { buildPluginContext, silentLogger } from '../../../fixtures/runtime';

describe('plugin event guild locale', () => {
  it('scopes simultaneous message/member events independently and keeps DM fallback', async () => {
    const scope = new GuildLocaleContext((guildId) => ({
      language: guildId === 'a' ? 'en' : 'zh-TW',
      timeZone: 'UTC',
    }));
    const base = await I18NextTranslator.create({
      en: { commands: {}, errors: {}, replies: { greeting: 'English' } },
      'zh-TW': { commands: {}, errors: {}, replies: { greeting: 'Default' } },
    });
    const dispatcher = new EventDispatcher(silentLogger());
    const sent: string[] = [];
    dispatcher.subscribe('test', buildPluginContext({ translator: scope.translator(base) }), {
      messageCreate: async (ctx) => {
        await Promise.resolve();
        sent.push(ctx.translator.t('replies:greeting'));
      },
      guildMemberUpdate: async (ctx) => {
        await Promise.resolve();
        sent.push(ctx.translator.t('replies:greeting'));
      },
    });
    await Promise.all([
      dispatcher.emit('messageCreate', { guildId: 'a' } as never),
      dispatcher.emit(
        'guildMemberUpdate',
        { guild: { id: 'b' } } as never,
        { guild: { id: 'b' } } as never,
      ),
      dispatcher.emit('messageCreate', { guildId: null } as never),
    ]);
    expect(sent.sort()).toEqual(['Default', 'Default', 'English']);
  });

  it('extracts bulk-message/guild events and source-guild claim DMs without treating ordinary IDs as guilds', () => {
    expect(guildIdForEvent('messageDeleteBulk', [new Map(), { guildId: 'a' }])).toBe('a');
    expect(guildIdForEvent('guildCreate', [{ id: 'b' }])).toBe('b');
    expect(guildIdForEvent('messageCreate', [{ id: 'message', guildId: null }])).toBeUndefined();
    expect(
      guildIdForInteraction({
        guildId: null,
        customId: 'thread_claim|approve|123456789012345678|123456789012345679|claim',
      } as never),
    ).toBe('123456789012345678');
  });
});
