/**
 * Behaviour coverage for the `ai_settings` modal submit handler.
 *
 * The modal writes a user's LLM provider settings, so every guard in
 * front of the persist matters: the provider is read out of the
 * customId (an unknown one must not reach the repo), the temperature is
 * free text (an out-of-range value must not be stored), and a
 * non-whitelisted user must not gain settings by submitting the form.
 * The success path is pinned on what lands in the repo, not on the
 * confirmation text.
 */
import type { ModalSubmitInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import ai_settings_modal from '../../../../src/handlers/modals/ai_settings';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { Repos } from '../../../../src/persistence/repositories';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const GUILD_ID = 'g-1';
const USER_ID = 'u-1';

const dbErr = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));

interface BuildInput {
  readonly customId?: string;
  readonly model?: string;
  readonly webSearch?: string;
  readonly temperature?: string;
  readonly systemPrompt?: string;
  /** `false` means the user has no whitelist row. */
  readonly whitelisted?: boolean;
  readonly updateFails?: boolean;
  readonly config?: Record<string, unknown>;
  readonly isAdmin?: boolean;
}

const build = ({
  customId = 'ai_settings|openai',
  model = 'gpt-4o',
  webSearch = 'on',
  temperature = '0.7',
  systemPrompt = 'be terse',
  whitelisted = true,
  updateFails = false,
  config = {},
  isAdmin = false,
}: BuildInput = {}) => {
  const update = vi.fn(async () => (updateFails ? dbErr() : ok(true)));
  const repos = {
    userApiSetting: {
      findByUserId: vi.fn(async () => ok(whitelisted ? { userId: USER_ID } : undefined)),
      update,
    },
  } as unknown as Repos;

  const { bot } = buildFakeBot({
    config,
    isAdmin: () => isAdmin,
    connectionManager: undefined,
    getRepos: (guildId: string) => (guildId === GUILD_ID ? repos : undefined),
  });

  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    customId,
    user: { id: USER_ID },
    guild: { id: GUILD_ID },
    guildId: GUILD_ID,
    deferred: false,
    replied: false,
    reply,
    editReply: reply,
    fields: {
      getStringSelectValues: (name: string) => {
        const value = name === 'model' ? model : webSearch;
        return value === '' ? [] : [value];
      },
      getTextInputValue: (name: string) => (name === 'temperature' ? temperature : systemPrompt),
    },
  } as unknown as ModalSubmitInteraction;

  return { bot, interaction, reply, update };
};

const run = async (input: BuildInput = {}) => {
  const built = build(input);
  await new ai_settings_modal().execute(built.interaction, built.bot);
  return built;
};

/** Content of the single reply the handler produced. */
const replyContent = (reply: ReturnType<typeof vi.fn>): string =>
  (reply.mock.calls[0]?.[0] as { content: string }).content;

describe('ai_settings modal', () => {
  const restricted = {
    ai: {
      models: {
        default: { provider: 'openai', model: 'gpt-allowed' },
        allowed: { openai: ['gpt-allowed'] },
      },
    },
  };

  it("persists a member's allowed model", async () => {
    const { update } = await run({ config: restricted, model: 'gpt-allowed' });
    expect(update).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ model: 'gpt-allowed' }));
  });

  it('rejects a model removed since the settings form was opened', async () => {
    const built = build({ model: 'gpt-4o' });
    Object.assign(built.bot.config, restricted);
    await new ai_settings_modal().execute(built.interaction, built.bot);
    expect(built.update).not.toHaveBeenCalled();
    expect(replyContent(built.reply)).toBe('replies:ai_settings.model_not_allowed');
  });

  it("rejects a member's provider outside the allowlist", async () => {
    const { update, reply } = await run({
      config: restricted,
      customId: 'ai_settings|xai',
      model: 'grok-model',
    });
    expect(update).not.toHaveBeenCalled();
    expect(replyContent(reply)).toBe('replies:ai_settings.model_not_allowed');
  });

  it("allows a bot admin's model outside the member allowlist", async () => {
    const { update } = await run({ config: restricted, model: 'gpt-4o', isAdmin: true });
    expect(update).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ model: 'gpt-4o' }));
  });
  it('persists the submitted settings against the caller', async () => {
    const { update } = await run();

    expect(update).toHaveBeenCalledWith(USER_ID, {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.7,
      web_search: true,
      system_prompt: 'be terse',
    });
  });

  it('stores web_search as false when the toggle came back off', async () => {
    const { update } = await run({ webSearch: 'off' });

    expect(update).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ web_search: false }));
  });

  it.each([
    ['an unknown provider', 'ai_settings|hal9000'],
    ['a customId from another component', 'something_else|openai'],
    ['a customId with no provider segment', 'ai_settings'],
  ])('rejects %s without touching the repo', async (_label, customId) => {
    const { update, reply } = await run({ customId });

    expect(update).not.toHaveBeenCalled();
    expect(replyContent(reply)).toBe('replies:ai_settings.modal_id_error');
  });

  it.each([
    ['above the ceiling', '2.5'],
    ['below zero', '-0.1'],
    ['not a number', 'warm'],
  ])('refuses a temperature %s', async (_label, temperature) => {
    const { update, reply } = await run({ temperature });

    expect(update).not.toHaveBeenCalled();
    expect(replyContent(reply)).toBe('replies:ai_settings.invalid_temperature');
  });

  it('refuses a submission whose model select came back empty', async () => {
    const { update, reply } = await run({ model: '' });

    expect(update).not.toHaveBeenCalled();
    expect(replyContent(reply)).toBe('replies:ai_settings.missing_model_or_web_search');
  });

  it('does not create settings for a user who is not whitelisted', async () => {
    const { update, reply } = await run({ whitelisted: false });

    expect(update).not.toHaveBeenCalled();
    expect(replyContent(reply)).toBe('errors:ai.not_whitelisted');
  });

  it('reports the failure copy instead of a confirmation when the write fails', async () => {
    const { reply } = await run({ updateFails: true });

    expect(replyContent(reply)).toContain('replies:ai_settings.failed');
  });
});
