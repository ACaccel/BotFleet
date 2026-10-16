import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { DEFAULT_MODELS } from '../../../infra/llm';
import { requireGuildRepos } from '../../require-guild-repos';
import { buildWhitelistDefaults } from './build-default-settings';

import { replyForError } from '../../../infra/discord/reply-for-error';
export default class ai_whitelist_add extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'ai_whitelist_add',
      category: 'ai',
      options: {
        user: [
          {
            name: 'user',
            required: true,
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!bot.isAdmin(interaction.user.id)) {
      await interaction.editReply({
        content: bot.translator?.t('errors:permission.admin_only_short') ?? '',
      });
      return;
    }

    const target = interaction.options.getUser('user', true);
    const repos = await requireGuildRepos(bot, interaction);
    if (repos === null) return;

    try {
      // Repo methods return Result<T, DatabaseError>; an `err`
      // is re-thrown into the surrounding catch.
      const existingResult = await repos.userApiSetting.findByUserId(target.id);
      if (!existingResult.ok) throw existingResult.error;
      if (existingResult.value) {
        await interaction.editReply({
          content:
            bot.translator?.t('replies:ai_whitelist.already_in', { user: target.displayName }) ??
            '',
        });
        return;
      }
      // Resolve the cheapest still-listed xAI model; fall back to
      // the static seed when the resolver is unavailable (e.g. a bot
      // without LlmChatPlugin).
      const xaiModel = bot.defaultModelResolver?.current('xai') ?? DEFAULT_MODELS['xai'];
      const defaults = buildWhitelistDefaults(xaiModel);
      const createResult = await repos.userApiSetting.create(target.id, defaults);
      if (!createResult.ok) throw createResult.error;
      await interaction.editReply({
        content:
          bot.translator?.t('replies:ai_whitelist.added', {
            user: target.displayName,
            provider: defaults.provider,
          }) ?? '',
      });
    } catch (err) {
      await replyForError(
        interaction,
        bot,
        err,
        'replies:ai_whitelist.failed',
        interaction.guildId,
      );
    }
  }
}
