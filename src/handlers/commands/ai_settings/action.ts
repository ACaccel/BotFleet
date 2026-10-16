import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { type LLMProviderName } from '../../../infra/llm';
import { requireGuildRepos } from '../../require-guild-repos';
import { logError } from '@core/logger';

import { PROVIDER_CHOICES, type UserApiDoc } from './provider-choices';
import { checkAiSettingsReady } from './validate-ai-settings';
import { buildSettingsModal } from './build-settings-modal';
import { loadModelOptions } from './model-options';
import { allowedModelsFor, parseAiPolicy } from '../../../application/ai/policy';

export default class ai_settings extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'ai_settings',
      category: 'ai',
      options: {
        string: [{ name: 'provider', required: true, choices: PROVIDER_CHOICES }],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const provider = interaction.options.getString('provider', true) as LLMProviderName;
    const repos = await requireGuildRepos(bot, interaction);
    if (repos === null) return;
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';

    // `findByUserId` returns Result<UserApiSettingDoc | undefined,
    // DatabaseError>. On `err`, log and reply with the generic
    // operation-failed key.
    const docResult = await repos.userApiSetting.findByUserId(interaction.user.id);
    if (!docResult.ok) {
      logError(bot.logger, interaction.guildId, docResult.error);
      await interaction.reply({
        content: t('errors:db.operation_failed'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // An empty list still gets an honest "model list unavailable" reply
    // rather than a guessed list.
    // Members choose only from the configured allowlist; bot admins from every live model.
    const policy = parseAiPolicy(bot.config);
    const allowed = bot.isAdmin(interaction.user.id)
      ? undefined
      : allowedModelsFor(policy, provider);
    if (allowed !== undefined && allowed.length === 0) {
      await interaction.reply({
        content: t('replies:ai_settings.provider_not_allowed', { provider }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modelOptions = allowed
      ? [...allowed]
      : [...(await loadModelOptions(bot.modelCatalog, provider))];
    const check = checkAiSettingsReady(docResult.value as UserApiDoc | undefined, modelOptions);
    if (!check.ok) {
      const key =
        check.reason === 'no_doc'
          ? 'errors:ai.not_whitelisted'
          : 'replies:ai_settings.model_list_unavailable';
      await interaction.reply({
        content: t(key, { provider }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.showModal(
      buildSettingsModal(provider, check.doc, modelOptions, bot.translator),
    );
  }
}
