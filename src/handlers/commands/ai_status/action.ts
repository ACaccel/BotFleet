import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { requireGuildRepos } from '../../require-guild-repos';

import { effectiveModel, parseAiPolicy } from '../../../application/ai/policy';
import { replyForError } from '../../../infra/discord/reply-for-error';
export default class ai_status extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'ai_status',
      category: 'ai',
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const repos = await requireGuildRepos(bot, interaction);
    if (repos === null) return;

    try {
      // A repo `err` is re-thrown into the surrounding catch.
      const docResult = await repos.userApiSetting.findByUserId(userId);
      if (!docResult.ok) throw docResult.error;
      const doc = docResult.value;

      if (!doc) {
        await interaction.editReply({
          content: bot.translator?.t('errors:ai.not_whitelisted') ?? '',
        });
        return;
      }

      // Truncate system prompt to keep total reply well under Discord's 2000-char limit.
      const PROMPT_PREVIEW_MAX = 1500;
      const t = (key: string, params?: Record<string, string | number>): string =>
        bot.translator?.t(key, params) ?? '';
      const promptDisplay = doc.system_prompt
        ? doc.system_prompt.length > PROMPT_PREVIEW_MAX
          ? t('replies:ai_status.system_prompt_preview', {
              preview: doc.system_prompt.slice(0, PROMPT_PREVIEW_MAX),
              length: doc.system_prompt.length,
            })
          : `\`${doc.system_prompt}\``
        : t('replies:ai_status.system_prompt_not_set');
      const lines = [
        `**Provider:** \`${doc.provider}\``,
        `**Model:** \`${doc.model}\``,
        `**Temperature:** \`${doc.temperature}\``,
        t('replies:ai_status.web_search_status', {
          value: t(
            doc.web_search ? 'replies:ai_settings.toggle_on' : 'replies:ai_settings.toggle_off',
          ),
        }),
        `**System Prompt:** ${promptDisplay}`,
      ];
      const used = effectiveModel(parseAiPolicy(bot.config), doc);
      if (used.fellBack && !bot.isAdmin(userId)) {
        lines.push(
          t('replies:ai_status.model_fallback', { provider: used.provider, model: used.model }),
        );
      }
      await interaction.editReply({ content: lines.join('\n') });
    } catch (err) {
      await replyForError(interaction, bot, err, 'replies:ai_status.failed', interaction.guildId);
    }
  }
}
