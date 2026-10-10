import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  InteractionReplyOptions,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';
import { ArchiveAccessError } from './access';
import type { ArchiveAccess } from './access';
import {
  patchArchivePublicDetails,
  isArchiveQueuedReply,
  archiveDetailFingerprint,
} from '../../../infra/archive/public-message';
import { bindArchiveNavigationMessage } from './navigation';
import {
  archivePublicReference,
  archivePublicReplyTarget,
  ensureArchivePublicReference,
} from './public-reply';
import { bindArchiveConfirmationMessage } from './public-reference';
import { archivePlanProgressEmbed } from './plan-progress';
import { isArchiveBulkReply, publishArchiveBulkReply } from './bulk-public-reply';

/** Navigation owns its originating panel; commands can open a durable worker notice. */
export const publishArchiveReply = async (
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
  payload: InteractionReplyOptions,
  bot?: BaseBot,
  access?: ArchiveAccess,
): Promise<void> => {
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (content.length > 1900) throw new Error('Archive presenter exceeded the public detail budget');
  const { flags: _flags, ...editPayload } = payload;
  if (
    bot !== undefined &&
    access !== undefined &&
    isArchiveBulkReply(payload) &&
    'message' in interaction &&
    interaction.message !== null
  ) {
    await publishArchiveBulkReply(bot, access.debugId, interaction.message.id, payload);
    return;
  }
  if (bot !== undefined && access !== undefined) {
    const target = archivePublicReplyTarget(payload);
    const origin =
      'message' in interaction &&
      interaction.message !== null &&
      !('fields' in interaction) &&
      interaction.message.flags?.has(MessageFlags.Ephemeral) !== true
        ? { channelId: access.debugId, messageId: interaction.message.id }
        : undefined;
    const canonical =
      target === undefined
        ? undefined
        : origin === undefined
          ? await ensureArchivePublicReference(bot, access, target, { restoreStatus: true })
          : await archivePublicReference(access, target);
    const reference = origin ?? canonical;
    if (target !== undefined && reference === undefined)
      throw new ArchiveAccessError('replies:archive.navigation_stale');
    if (reference !== undefined) {
      if (
        origin !== undefined &&
        target !== undefined &&
        canonical?.messageId === reference.messageId
      )
        await ensureArchivePublicReference(bot, access, target, { restoreStatus: true });
      for (const row of payload.components ?? []) {
        const json = 'toJSON' in row ? row.toJSON() : row;
        if ('components' in json)
          for (const component of json.components)
            if ('custom_id' in component && typeof component.custom_id === 'string') {
              bindArchiveNavigationMessage(
                component.custom_id,
                reference.channelId,
                reference.messageId,
                access.guildId,
              );
              const token = /^archive_confirm\|([A-Za-z0-9_-]{24})$/.exec(component.custom_id)?.[1];
              if (token !== undefined)
                await bindArchiveConfirmationMessage(access, token, interaction.user.id, reference);
            }
      }
      if (target !== undefined && 'jobId' in target && isArchiveQueuedReply(payload))
        await access.connection.collection('archive_jobs').updateOne(
          { guildId: access.guildId, jobId: target.jobId },
          {
            $set: {
              'notification.transientDetailHash': archiveDetailFingerprint({
                description: content,
              }),
            },
          },
        );
      const planProgress =
        target !== undefined && 'runId' in target && canonical?.messageId !== reference.messageId
          ? await archivePlanProgressEmbed(bot, access, target.runId)
          : undefined;
      await patchArchivePublicDetails(
        bot.client,
        reference.channelId,
        reference.messageId,
        {
          ...editPayload,
          content,
          ...(planProgress === undefined
            ? {}
            : {
                embeds: [
                  planProgress,
                  ...(editPayload.embeds ?? (content.length > 0 ? [{ description: content }] : [])),
                ],
              }),
          components: payload.components ?? [],
        },
        { retainStatus: canonical?.messageId === reference.messageId },
      );
      if (
        !('message' in interaction) ||
        interaction.message === null ||
        'fields' in interaction ||
        interaction.message.flags?.has(MessageFlags.Ephemeral) === true
      )
        await interaction.deleteReply();
      return;
    }
  }
  await interaction.editReply({
    ...editPayload,
    content,
    components: payload.components ?? [],
    attachments: [],
    allowedMentions: { parse: [] },
  });
};

export { archiveFailure } from './archive-failure';
