import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { unwrap } from '@core/result';
import { Command } from '../command';
import {
  assertThreadApplicant,
  requireThreadRepo,
  resolveManagedThread,
  ThreadManagementError,
  threadManagementFailure,
} from '../../thread-management-common';

export default class thread_manager extends Command {
  constructor() {
    super();
    const thread = [{ name: 'thread', required: true }];
    const user = [{ name: 'user', required: true }];
    this.setConfig({
      name: 'thread_manager',
      category: 'admin',
      guildOnly: true,
      subcommands: [
        { name: 'add', options: { channel: thread, user } },
        { name: 'remove', options: { channel: thread, user } },
        {
          name: 'list',
          options: { channel: thread, integer: [{ name: 'page', required: false, min: 1 }] },
        },
      ],
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!bot.isAdmin(interaction.user.id)) throw new ThreadManagementError('manager_admin_only');
      if (!interaction.guild) throw new ThreadManagementError('thread_only');
      const repo = requireThreadRepo(bot, interaction.guild.id);
      const thread = await resolveManagedThread(
        interaction.guild,
        interaction.options.getChannel('thread', true).id,
      );
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const users = [...unwrap(await repo.listManagers(bot.clientId, thread.id))].sort();
        const pages = Math.max(1, Math.ceil(users.length / 20));
        const page = interaction.options.getInteger('page') ?? 1;
        if (!Number.isSafeInteger(page) || page < 1 || page > pages) {
          await interaction.editReply({
            content:
              bot.translator?.t('replies:thread_moderation.list_invalid_page', { pages }) ?? '',
            allowedMentions: { parse: [] },
          });
          return;
        }
        const header =
          bot.translator?.t(
            `replies:thread_moderation.manager_${users.length ? 'list' : 'empty'}`,
            { count: users.length, page, pages },
          ) ?? '';
        const rows = users.slice((page - 1) * 20, page * 20).map((id) => `<@${id}> (\`${id}\`)`);
        await interaction.editReply({
          content: [header, ...rows].join('\n'),
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action !== 'add' && action !== 'remove') throw new ThreadManagementError('claim_stale');
      const user = interaction.options.getUser('user', true);
      if (action === 'add') {
        if (
          thread.ownerId === user.id ||
          bot.isAdmin(user.id) ||
          unwrap(await repo.isManager(bot.clientId, thread.id, user.id))
        ) {
          throw new ThreadManagementError('manager_already');
        }
        await assertThreadApplicant(thread, user.id);
      }
      unwrap(
        await repo.setManager(
          bot.clientId,
          thread.id,
          user.id,
          interaction.user.id,
          action === 'add',
          Date.now(),
        ),
      );
      await interaction.editReply({
        content:
          bot.translator?.t(
            `replies:thread_moderation.manager_${action === 'add' ? 'added' : 'removed'}`,
            { user: `<@${user.id}>` },
          ) ?? '',
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await threadManagementFailure(interaction, bot, error);
    }
  }
}
