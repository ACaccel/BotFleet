import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { Command, type CommandSuggestions } from '../command';

import { cancelActivity } from '../../../application/activity/activity';
import { requireGuildRepos } from '../../require-guild-repos';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
import { canManageActivity } from '../activity-shared/authority';
import { buildActivityDepsFromBot } from '../activity-shared/deps-from-bot';
import { visibleActivities } from '../activity-shared/visible';

/** `/activity cancel`: its creator or a manager cancels an activity picked by name. */
export default class activity_cancel extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'activity_cancel',
      category: 'server_activity',
      guildOnly: true,
      options: { string: [{ name: 'activity', required: true, autocomplete: true }] },
    });
  }

  /** Activities the member can see and cancel, matching what they typed. */
  public override autocomplete = async (
    interaction: AutocompleteInteraction,
    bot: BaseBot,
  ): Promise<CommandSuggestions> => {
    const guild = interaction.guild;
    const repos = guild ? bot.getRepos(guild.id) : undefined;
    if (!guild || !repos) return [];
    const result = await repos.activity.listAll();
    if (!result.ok) return [];
    const typed = interaction.options.getFocused().toLowerCase();
    return visibleActivities(guild, interaction.user.id, result.value)
      .filter((doc) => doc.status !== 'cancelled')
      .filter((doc) => canManageActivity(interaction, bot, doc.creator_id))
      .filter((doc) => doc.title.toLowerCase().includes(typed))
      .map((doc) => ({ name: doc.title, value: doc.activity_id }));
  };

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string): string => bot.translator?.t(`replies:activity.${key}`) ?? '';
    try {
      const repos = await requireGuildRepos(bot, interaction);
      const guild = interaction.guild;
      if (repos === null || guild === null) return;
      const activityId = getRequiredString(interaction, 'activity');
      const found = await repos.activity.findByActivityId(activityId);
      if (!found.ok) throw found.error;
      const doc = found.value;
      if (!doc || visibleActivities(guild, interaction.user.id, [doc]).length === 0) {
        await interaction.editReply({ content: t('not_found') });
        return;
      }
      if (!canManageActivity(interaction, bot, doc.creator_id)) {
        await interaction.editReply({ content: t('manage_forbidden') });
        return;
      }
      const cancelled = await cancelActivity(buildActivityDepsFromBot(bot), guild.id, activityId);
      await interaction.editReply({ content: t(cancelled ? 'cancelled' : 'not_open') });
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:activity.failed', interaction.guildId);
    }
  }
}
