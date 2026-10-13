import type { ModalSubmitInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '@modal';

import { type LLMProviderName } from '../../../infra/llm';
import { requireGuildRepos } from '../../require-guild-repos';
import { isModelAllowed, parseAiPolicy } from '../../../application/ai/policy';

import { replyForError } from '../../../infra/discord/reply-for-error';
const VALID_PROVIDERS: ReadonlySet<LLMProviderName> = new Set([
  'xai',
  'openai',
  'anthropic',
  'gemini',
]);

export default class ai_settings_modal extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    // customId format: ai_settings|<provider>
    const [modalType, providerRaw] = interaction.customId.split('|');
    if (
      modalType !== 'ai_settings' ||
      !providerRaw ||
      !VALID_PROVIDERS.has(providerRaw as LLMProviderName)
    ) {
      await interaction.reply({
        content: bot.translator?.t('replies:ai_settings.modal_id_error') ?? '',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const provider = providerRaw as LLMProviderName;

    const userId = interaction.user.id;
    const repos = await requireGuildRepos(bot, interaction);
    if (repos === null) return;

    // Read fields. Select menus return readonly string[].
    const modelValues = interaction.fields.getStringSelectValues('model');
    const webSearchValues = interaction.fields.getStringSelectValues('web_search');
    const tempStr = interaction.fields.getTextInputValue('temperature');
    const systemPrompt = interaction.fields.getTextInputValue('system_prompt');

    const model = modelValues[0];
    const webSearchValue = webSearchValues[0];
    if (!model || !webSearchValue) {
      await interaction.reply({
        content: bot.translator?.t('replies:ai_settings.missing_model_or_web_search') ?? '',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Recheck: the form may predate an allowlist change.
    if (!bot.isAdmin(userId) && !isModelAllowed(parseAiPolicy(bot.config), provider, model)) {
      await interaction.reply({
        content: bot.translator?.t('replies:ai_settings.model_not_allowed', { model }) ?? '',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const temperature = Number.parseFloat(tempStr);
    if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
      await interaction.reply({
        content: bot.translator?.t('replies:ai_settings.invalid_temperature') ?? '',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      // Repo methods return Result<T, DatabaseError>; an `err`
      // is re-thrown into the surrounding catch.
      const docResult = await repos.userApiSetting.findByUserId(userId);
      if (!docResult.ok) throw docResult.error;
      if (!docResult.value) {
        await interaction.reply({
          content: bot.translator?.t('errors:ai.not_whitelisted') ?? '',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const updateResult = await repos.userApiSetting.update(userId, {
        provider,
        model,
        temperature,
        web_search: webSearchValue === 'on',
        system_prompt: systemPrompt,
      });
      if (!updateResult.ok) throw updateResult.error;
    } catch (err) {
      await replyForError(interaction, bot, err, 'replies:ai_settings.failed', interaction.guildId);
      return;
    }

    // Show the full system prompt. Cap below Discord's 2000-char message
    // limit so the surrounding bullet lines still fit; truncate with an
    // explicit marker rather than silently dropping the tail.
    const PROMPT_DISPLAY_MAX = 1700;
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';
    const promptDisplay = systemPrompt
      ? systemPrompt.length > PROMPT_DISPLAY_MAX
        ? t('replies:ai_settings.modal_system_prompt_preview', {
            preview: systemPrompt.slice(0, PROMPT_DISPLAY_MAX),
            length: systemPrompt.length,
          })
        : `\n\`\`\`\n${systemPrompt}\n\`\`\``
      : t('replies:ai_settings.system_prompt_not_set');
    const webSearchLabel = t(
      webSearchValue === 'on' ? 'replies:ai_settings.toggle_on' : 'replies:ai_settings.toggle_off',
    );
    await interaction.reply({
      content: [
        t('replies:ai_settings.updated_header'),
        `• Provider: \`${provider}\``,
        `• Model: \`${model}\``,
        `• Temperature: \`${temperature}\``,
        t('replies:ai_settings.web_search_status', { value: webSearchLabel }),
        `• System Prompt: ${promptDisplay}`,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }
}
