import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'node-schedule';
import { GuildLocaleContext, type Translator } from '../../../src/core/i18n';
import { rebootActivityJobs, type ActivityDeps } from '../../../src/application/activity/activity';
import { ok } from '../../../src/core/result';
import { silentLogger } from '../../fixtures/runtime';

const callbacks = new Map<string, () => unknown>();
vi.mock('node-schedule', () => ({
  default: {
    scheduleJob: (_date: Date, callback: () => unknown) => {
      const key = String(callbacks.size);
      callbacks.set(key, callback);
      return { cancel: vi.fn() };
    },
  },
}));
afterEach(() => {
  callbacks.clear();
});

describe('restored guild activity schedules', () => {
  it('rebuilds each guild in its own scope and resolves saved language when the job fires', async () => {
    const language = new Map<string, 'en' | 'zh-TW'>([
      ['a', 'en'],
      ['b', 'zh-TW'],
    ]);
    const scope = new GuildLocaleContext((guildId) => ({
      language: language.get(guildId ?? '') ?? 'en',
      timeZone: 'UTC',
    }));
    const base: Translator = {
      t: (key, _params, locale) => `${locale}:${key}`,
      tStrict: (key) => key,
      listMissingKeys: () => ({ en: [], 'zh-TW': [] }),
    };
    const translator = scope.translator(base);
    const sent: string[] = [];
    const now = Date.now();
    const guilds = new Map(
      ['a', 'b'].map((guildId) => {
        const channel = {
          isSendable: () => true,
          messages: { fetch: async () => ({ edit: async () => undefined }) },
          send: async (options: { content: string }) => {
            sent.push(`${guildId}:${options.content}`);
          },
        };
        return [guildId, { id: guildId, channels: { cache: new Map([['channel', channel]]) } }];
      }),
    );
    const docs = new Map(
      ['a', 'b'].map((guildId) => [
        guildId,
        {
          activity_id: guildId,
          message_id: guildId,
          channel_id: 'channel',
          title: 'Event',
          expired_at: now + 60000,
          status: 'open',
          participants: [],
          attendance: [],
        },
      ]),
    );
    const deps = {
      translator,
      logger: silentLogger(),
      jobMap: new Map<string, Job>(),
      client: { guilds: { cache: guilds } },
      registry: {
        listGuildIds: () => ['a', 'b'],
        getRepos: (guildId: string) => ({
          activity: {
            listAll: async () => ok([docs.get(guildId)]),
            finish: async () => ok(true),
            findByActivityId: async () => ok(docs.get(guildId)),
          },
        }),
      },
    } as unknown as ActivityDeps;
    await rebootActivityJobs(deps);
    expect(callbacks.size).toBe(2);
    language.set('a', 'zh-TW');
    language.set('b', 'en');
    scope.run('a', () => {
      for (const callback of callbacks.values()) callback();
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toContain('a:zh-TW:replies:activity.closed_announcement');
    expect(sent).toContain('b:en:replies:activity.closed_announcement');
  });
});
