/**
 * `/db` — read-only inspection of every guild database, for the bot's admins.
 *
 * Hosted by nijika only (see `BaseBot.supportsDbInspect`). Replies are
 * ephemeral; reads run on a verified read-only MongoDB account.
 */
import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';

import { bindTranslator } from '../../../core/i18n';
import { getOptionalString, getRequiredString } from '../../../infra/discord/options';
import { Command, type CommandSuggestions } from '../command';
import { requireDatabase, requireDbInspectService } from '../db-shared/access';
import { dbFailure } from '../db-shared/failure';
import { buildDocumentReply } from '../db-shared/document-view';
import { buildListReply } from '../db-shared/list-view';
import { buildSchemaReply } from '../db-shared/schema-view';
import { buildStatsReply } from '../db-shared/stats-view';
import { guildLabel } from '../db-shared/values';
import { suggestDbOptions } from './autocomplete';
import { dbCommandConfig } from './config';

export default class db extends Command {
  constructor() {
    super();
    this.setConfig(dbCommandConfig);
  }

  public override autocomplete = (
    interaction: AutocompleteInteraction,
    bot: BaseBot,
  ): Promise<CommandSuggestions> => suggestDbOptions(interaction, bot);

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = bindTranslator(bot.translator);
    if (!bot.isAdmin(interaction.user.id)) {
      await interaction.reply({
        content: t('errors:permission.admin_only_short'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const service = requireDbInspectService(bot);
      const database = requireDatabase(interaction);
      const guild = guildLabel(interaction.client, database, t);
      const userId = interaction.user.id;
      switch (interaction.options.getSubcommand()) {
        case 'stats':
          await interaction.editReply(
            buildStatsReply(await service.stats(userId, database), guild, t),
          );
          return;
        case 'schema': {
          const collection = getRequiredString(interaction, 'collection');
          const description = await service.describe(userId, database, collection);
          await interaction.editReply(buildSchemaReply(description, guild, t));
          return;
        }
        case 'list': {
          const sort = getOptionalString(interaction, 'sort');
          const page = await service.query({
            userId,
            database,
            collection: getRequiredString(interaction, 'collection'),
            filter: {
              field: getOptionalString(interaction, 'field'),
              operator: getOptionalString(interaction, 'operator'),
              value: getOptionalString(interaction, 'value'),
            },
            ...(sort === undefined ? {} : { sort }),
          });
          await interaction.editReply(buildListReply(page, guild, t));
          return;
        }
        case 'get': {
          const view = await service.get(
            userId,
            database,
            getRequiredString(interaction, 'collection'),
            getRequiredString(interaction, 'id'),
          );
          await interaction.editReply(buildDocumentReply(view, guild, t));
          return;
        }
        default:
          return;
      }
    } catch (error) {
      await dbFailure(interaction, bot, error);
    }
  }
}
