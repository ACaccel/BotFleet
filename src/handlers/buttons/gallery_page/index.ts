/**
 * The paging buttons under an nhentai / wnacg reader message: first,
 * previous, the position button that opens the jump form, next and last.
 */
import type { ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { decodeGalleryButtonId } from '../../../application/gallery-reader/custom-id';
import { buildGalleryJumpModal } from '../../../application/gallery-reader/view';
import { bindTranslator } from '../../../core/i18n';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { galleryRefusal, refuseGalleryInteraction, turnGalleryPage } from '../../gallery-page-turn';

export default class gallery_page extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    const t = bindTranslator(bot.translator);
    try {
      const target = decodeGalleryButtonId(interaction.customId);
      const reader = bot.galleryReader;
      const refusal = galleryRefusal(reader, target?.source, interaction.channel);
      if (refusal !== undefined || target === undefined || reader === undefined) {
        await refuseGalleryInteraction(interaction, t, refusal ?? 'inactive');
        return;
      }
      if (target.action === 'jump') {
        await interaction.showModal(buildGalleryJumpModal(target, target.total, t));
        return;
      }
      await turnGalleryPage(interaction, reader, target, target.page, t);
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
