/**
 * The page turn the gallery buttons and the jump form share, plus the
 * checks both run first.
 *
 * Any member may turn a reader's page. A page already staged is shown in
 * the interaction's single response; otherwise the interaction is
 * acknowledged before anything slow. Either way the turn runs under the
 * reader's per-message lock so two members pressing at once edit the
 * message one after the other. A page that cannot be loaded leaves the message as it was and
 * tells only the presser.
 */
import {
  MessageFlags,
  type ButtonInteraction,
  type ModalMessageModalSubmitInteraction,
} from 'discord.js';

import type { GalleryReaderService } from '../application/gallery-reader/service';
import { buildGalleryMessage } from '../application/gallery-reader/view';
import type { BoundTranslate } from '../core/i18n';
import { isAgeRestrictedChannel } from '../infra/discord';
import type { GallerySourceName } from '../infra/link-preview';

type PageTurnInteraction = ButtonInteraction | ModalMessageModalSubmitInteraction;

export const refuseGalleryInteraction = async (
  interaction: { readonly reply: ButtonInteraction['reply'] },
  t: BoundTranslate,
  key: 'inactive' | 'age_restricted' | 'jump_invalid',
): Promise<void> => {
  await interaction.reply({
    content: t(`replies:gallery_preview.${key}`),
    flags: MessageFlags.Ephemeral,
  });
};

/**
 * Why a reader interaction may not proceed, or `undefined` when it may: the
 * reader must still be running for this source and the channel must still
 * be age-restricted (it may have been changed since the preview was posted).
 */
export const galleryRefusal = (
  reader: GalleryReaderService | undefined,
  source: GallerySourceName | undefined,
  channel: PageTurnInteraction['channel'],
): 'inactive' | 'age_restricted' | undefined => {
  if (reader === undefined || source === undefined || !reader.supports(source)) return 'inactive';
  return isAgeRestrictedChannel(channel) ? undefined : 'age_restricted';
};

export const turnGalleryPage = async (
  interaction: PageTurnInteraction,
  reader: GalleryReaderService,
  target: { readonly source: GallerySourceName; readonly id: string },
  page: number,
  t: BoundTranslate,
): Promise<void> => {
  const lockKey = interaction.message.id;
  // A staged page needs no network wait, so the turn is answered in one
  // response instead of an acknowledgement plus an edit. Behind another
  // turn it could wait past the acknowledgement window, so only when idle.
  const staged = reader.isBusy(lockKey)
    ? undefined
    : reader.stagedPage(target.source, target.id, page);
  if (staged?.status === 'ok') {
    await reader.serialize(lockKey, () =>
      interaction.update({
        ...buildGalleryMessage(staged.gallery, staged.page, staged.media, t),
        attachments: [],
      }),
    );
    return;
  }
  // A cold page means a download, which can outlast the acknowledgement window.
  await interaction.deferUpdate();
  await reader.serialize(lockKey, async () => {
    const outcome = await reader.loadPage(target.source, target.id, page);
    if (outcome.status !== 'ok') {
      await interaction.followUp({
        content: t(`replies:gallery_preview.${outcome.status}`),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.editReply({
      ...buildGalleryMessage(outcome.gallery, outcome.page, outcome.media, t),
      // Replace the previous page's upload rather than accumulating files.
      attachments: [],
    });
  });
};
