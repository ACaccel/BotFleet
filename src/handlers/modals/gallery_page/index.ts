/** The jump form behind a gallery reader's position button. */
import type { ModalSubmitInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '@modal';

import {
  decodeGalleryModalId,
  GALLERY_JUMP_INPUT_ID,
} from '../../../application/gallery-reader/custom-id';
import { bindTranslator } from '../../../core/i18n';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { galleryRefusal, refuseGalleryInteraction, turnGalleryPage } from '../../gallery-page-turn';

const PAGE_RE = /^\d{1,4}$/;

export default class gallery_page_modal extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    const t = bindTranslator(bot.translator);
    try {
      const target = decodeGalleryModalId(interaction.customId);
      const reader = bot.galleryReader;
      if (!interaction.isFromMessage()) {
        await refuseGalleryInteraction(interaction, t, 'inactive');
        return;
      }
      const refusal = galleryRefusal(reader, target?.source, interaction.channel);
      if (refusal !== undefined || target === undefined || reader === undefined) {
        await refuseGalleryInteraction(interaction, t, refusal ?? 'inactive');
        return;
      }
      const raw = interaction.fields.getTextInputValue(GALLERY_JUMP_INPUT_ID).trim();
      const page = PAGE_RE.test(raw) ? Number(raw) : 0;
      if (page < 1) {
        await refuseGalleryInteraction(interaction, t, 'jump_invalid');
        return;
      }
      // A page past the end shows the last page; the reader clamps it.
      await turnGalleryPage(interaction, reader, target, page, t);
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:gallery_preview.failed',
        interaction.guildId,
      );
    }
  }
}
