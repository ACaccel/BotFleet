/**
 * `/ai status`, `/ai whitelist add` and `/ai whitelist remove` against an
 * in-memory settings store. Every reply is private; the whitelist edits
 * change the store only for an admin and only when the state differs.
 * (The non-admin refusal of the whitelist edits is pinned by
 * `grouped-ai-thread-traffic.test.ts`.)
 */
import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';

import AiStatus from '../../../../src/handlers/commands/ai_status/action';
import AiWhitelistAdd from '../../../../src/handlers/commands/ai_whitelist_add/action';
import AiWhitelistRemove from '../../../../src/handlers/commands/ai_whitelist_remove/action';
import { err, ok } from '../../../../src/core/result';
import { DEFAULT_MODELS } from '../../../../src/infra/llm';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GUILD_ID = 'g-1';

interface StoredSetting {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly system_prompt: string;
  readonly web_search: boolean;
}

const setting = (overrides: Partial<StoredSetting> = {}): StoredSetting => ({
  provider: 'openai',
  model: 'gpt-5-nano',
  temperature: 0.7,
  system_prompt: 'Be brief.',
  web_search: false,
  ...overrides,
});

type Failure = 'find' | 'create' | 'delete';

interface RunInput {
  readonly userId?: string;
  readonly stored?: Readonly<Record<string, StoredSetting>>;
  readonly fail?: Failure;
  readonly db?: boolean;
  readonly config?: unknown;
  readonly resolvedXaiModel?: string;
}

const run = async (
  Action: typeof AiStatus | typeof AiWhitelistAdd | typeof AiWhitelistRemove,
  input: RunInput = {},
) => {
  const store = new Map(Object.entries(input.stored ?? {}));
  const failure = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));
  const userApiSetting = {
    findByUserId: async (id: string) => (input.fail === 'find' ? failure() : ok(store.get(id))),
    create: async (id: string, defaults: StoredSetting) => {
      if (input.fail === 'create') return failure();
      store.set(id, defaults);
      return ok(defaults);
    },
    deleteByUserId: async (id: string) =>
      input.fail === 'delete' ? failure() : ok(store.delete(id)),
  };
  const { bot } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    isAdmin: (id: string) => id === 'admin',
    getRepos: (id: string) =>
      id === GUILD_ID && input.db !== false ? { userApiSetting } : undefined,
    connectionManager: undefined,
    config: input.config ?? {},
    ...(input.resolvedXaiModel === undefined
      ? {}
      : { defaultModelResolver: { current: () => input.resolvedXaiModel } }),
  });
  const sink = newInteractionSink();
  await new Action().execute(
    buildChatInputInteraction({
      commandName: 'ai',
      userId: input.userId ?? 'admin',
      users: { user: { id: 'target', displayName: 'Target' } },
      sink,
    }),
    bot,
  );
  expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
  return { store, content: sink.editReplies[0]?.content ?? '' };
};

describe('/ai status', () => {
  it("shows the member's own settings", async () => {
    const { content } = await run(AiStatus, {
      userId: 'member',
      stored: { member: setting({ web_search: true }) },
    });

    expect(content.split('\n')).toEqual([
      '**Provider:** `openai`',
      '**Model:** `gpt-5-nano`',
      '**Temperature:** `0.7`',
      'replies:ai_status.web_search_status:{"value":"replies:ai_settings.toggle_on"}',
      '**System Prompt:** `Be brief.`',
    ]);
  });

  it('says when no system prompt is set', async () => {
    const { content } = await run(AiStatus, {
      userId: 'member',
      stored: { member: setting({ system_prompt: '' }) },
    });

    expect(content).toContain('replies:ai_settings.toggle_off');
    expect(content).toContain('**System Prompt:** replies:ai_status.system_prompt_not_set');
  });

  it('previews a long system prompt so the reply stays within Discord limits', async () => {
    const prompt = 'p'.repeat(1600);
    const { content } = await run(AiStatus, {
      userId: 'member',
      stored: { member: setting({ system_prompt: prompt }) },
    });

    expect(content).toContain(
      `replies:ai_status.system_prompt_preview:{"preview":"${'p'.repeat(1500)}","length":1600}`,
    );
    expect(content).not.toContain('p'.repeat(1501));
  });

  describe('with a model policy that no longer allows the stored model', () => {
    const config = {
      ai: {
        models: { default: { provider: 'xai', model: 'grok-a' }, allowed: { xai: ['grok-a'] } },
      },
    };
    const fallback = 'replies:ai_status.model_fallback:{"provider":"xai","model":"grok-a"}';

    it('tells a member which model their chats actually use', async () => {
      const { content } = await run(AiStatus, {
        userId: 'member',
        config,
        stored: { member: setting() },
      });

      expect(content.split('\n').at(-1)).toBe(fallback);
    });

    it('leaves the notice out for an admin, whose choice is not restricted', async () => {
      const { content } = await run(AiStatus, { config, stored: { admin: setting() } });

      expect(content).not.toContain('model_fallback');
    });
  });

  it('tells a member who is not whitelisted', async () => {
    expect((await run(AiStatus, { userId: 'member' })).content).toBe('errors:ai.not_whitelisted');
  });

  it('turns a lookup failure into the trace-stamped failure reply', async () => {
    const { content } = await run(AiStatus, { fail: 'find' });

    expect(content).toMatch(/^replies:ai_status\.failed:\{"traceId":"[0-9a-z]{6}"\}$/);
  });

  it('answers a guild without a database', async () => {
    expect((await run(AiStatus, { db: false })).content).toBe('errors:db.not_found');
  });
});

describe('/ai whitelist add', () => {
  it('whitelists the target on the resolved xAI model', async () => {
    const { store, content } = await run(AiWhitelistAdd, { resolvedXaiModel: 'grok-cheapest' });

    expect(content).toBe('replies:ai_whitelist.added:{"user":"Target","provider":"xai"}');
    expect(store.get('target')).toEqual({
      provider: 'xai',
      model: 'grok-cheapest',
      temperature: 1,
      system_prompt: '',
      web_search: true,
    });
  });

  it('falls back to the static xAI default without a model resolver', async () => {
    const { store } = await run(AiWhitelistAdd);

    expect(store.get('target')?.model).toBe(DEFAULT_MODELS.xai);
  });

  it('keeps the existing settings of a member already on the list', async () => {
    const existing = setting();
    const { store, content } = await run(AiWhitelistAdd, { stored: { target: existing } });

    expect(content).toBe('replies:ai_whitelist.already_in:{"user":"Target"}');
    expect(store.get('target')).toBe(existing);
  });

  it.each(['find', 'create'] as const)(
    'turns a %s failure into the trace-stamped failure reply',
    async (fail) => {
      const { store, content } = await run(AiWhitelistAdd, { fail });

      expect(content).toMatch(/^replies:ai_whitelist\.failed:/);
      expect(store.size).toBe(0);
    },
  );

  it('answers a guild without a database', async () => {
    expect((await run(AiWhitelistAdd, { db: false })).content).toBe('errors:db.not_found');
  });
});

describe('/ai whitelist remove', () => {
  it('removes the target from the list', async () => {
    const { store, content } = await run(AiWhitelistRemove, { stored: { target: setting() } });

    expect(content).toBe('replies:ai_whitelist.removed:{"user":"Target"}');
    expect(store.has('target')).toBe(false);
  });

  it('says when the target was not on the list', async () => {
    const { content } = await run(AiWhitelistRemove);

    expect(content).toBe('replies:ai_whitelist.not_in:{"user":"Target"}');
  });

  it('turns a delete failure into the trace-stamped failure reply', async () => {
    const { store, content } = await run(AiWhitelistRemove, {
      fail: 'delete',
      stored: { target: setting() },
    });

    expect(content).toMatch(/^replies:ai_whitelist\.failed:/);
    expect(store.has('target')).toBe(true);
  });

  it('answers a guild without a database', async () => {
    expect((await run(AiWhitelistRemove, { db: false })).content).toBe('errors:db.not_found');
  });
});
