import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { Command, type CommandSuggestions } from '@cmd';

import { parseDuration } from '@core/scheduling';
import { startRollCall } from '../../../application/roll-call/roll-call';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalString } from '../../../infra/discord/options';
import { visibleActivities } from '../activity-shared/visible';
import { buildRollCallDepsFromBot } from './deps-from-bot';
import { resolveCallList } from './call-list';

/** Roll calls stay open between one minute and a day. */
const MAX_DEADLINE_MS = 24 * 60 * 60_000;

export default class roll_call extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'roll_call',
      category: 'events',
      guildOnly: true,
      options: {
        role: [{ name: 'role', required: false }],
        string: [
          { name: 'users', required: false, maxLength: 1000 },
          { name: 'activity', required: false, autocomplete: true },
          { name: 'deadline', required: false, maxLength: 10 },
        ],
      },
    });
  }

  /** Activities in channels the member can see, newest first. */
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
      .filter((doc) => doc.status !== 'cancelled' && doc.title.toLowerCase().includes(typed))
      .sort((a, b) => b.expired_at - a.expired_at)
      .map((doc) => ({ name: doc.title, value: doc.activity_id }));
  };

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';
    try {
      const guild = interaction.guild;
      const channel = interaction.channel;
      if (!guild || !channel?.isSendable()) {
        await interaction.editReply({ content: t('errors:command.channel_not_found') });
        return;
      }
      const deadlineRaw = getOptionalString(interaction, 'deadline');
      const offset = deadlineRaw === undefined ? undefined : parseDuration(deadlineRaw.trim());
      if (
        offset === null ||
        (offset !== undefined && (offset < 60_000 || offset > MAX_DEADLINE_MS))
      ) {
        await interaction.editReply({ content: t('replies:roll_call.invalid_deadline') });
        return;
      }

      const list = await resolveCallList(interaction, bot, guild);
      if (list.status === 'refused') {
        await interaction.editReply({
          content: t(list.key, { persona: bot.personaName, ...list.params }),
        });
        return;
      }
      const outcome = await startRollCall(buildRollCallDepsFromBot(bot), {
        guild,
        channel,
        creatorId: interaction.user.id,
        targets: list.targets,
        persona: bot.personaName,
        ...(list.activityId === undefined ? {} : { activityId: list.activityId }),
        ...(offset === undefined ? {} : { deadline: Date.now() + offset }),
      });
      await interaction.editReply({
        content: outcome === 'started' ? t('replies:roll_call.sent') : t('errors:db.not_found'),
      });
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:roll_call.failed', interaction.guildId);
    }
  }
}
