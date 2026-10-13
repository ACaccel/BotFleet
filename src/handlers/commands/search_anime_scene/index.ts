import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { postJson } from '../../../infra/http';
import { getOptionalNumber } from '../../../infra/discord/options';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { TraceMoeResponseSchema, type TraceMoeMatch } from './response';

const TRACE_MOE_SEARCH_URL = 'https://api.trace.moe/search';

export default class search_anime_scene extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'search_anime_scene',
      category: 'utility',
      options: {
        attachment: [
          {
            name: 'image',
            required: true,
          },
        ],
        number: [
          {
            name: 'display_num',
            required: false,
          },
        ],
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const image = interaction.options.get('image')?.attachment;
      if (!image) {
        await interaction.editReply({
          content: bot.translator?.t('replies:search_anime_scene.upload_image') ?? '',
        });
        return;
      }

      const { error: upstreamError, result } = await postJson(
        `${TRACE_MOE_SEARCH_URL}?url=${encodeURIComponent(image.url)}`,
        TraceMoeResponseSchema,
      );
      if (upstreamError !== '') {
        throw new Error(`trace.moe reported: ${upstreamError}`);
      }

      // `display_num` is capped at the number of matches; an
      // explicit 0 legitimately asks for none.
      const requested = getOptionalNumber(interaction, 'display_num');
      const shown = requested === undefined ? 1 : Math.min(requested, result.length);

      await interaction.editReply({
        embeds: result.slice(0, shown).map((match, index) => buildMatchEmbed(match, index, bot)),
      });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:search_anime_scene.failed',
        interaction.guild?.id,
      );
    }
  }
}

/** Render one trace.moe match as a Discord embed. */
const buildMatchEmbed = (match: TraceMoeMatch, index: number, bot: BaseBot): EmbedBuilder => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    bot.translator?.t(key, params) ?? '';
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(match.filename)
    .setURL(match.video)
    .setDescription(
      t('replies:search_anime_scene.description', {
        episode: match.episode ?? 'N/A',
        similarity: match.similarity.toFixed(2),
        fromMin: (match.from / 60).toFixed(0),
        fromSec: (match.from % 60).toFixed(2),
        toMin: (match.to / 60).toFixed(0),
        toSec: (match.to % 60).toFixed(2),
      }),
    )
    .setImage(match.image)
    .setTimestamp()
    .setFooter({ text: t('replies:search_anime_scene.footer', { index: index + 1 }) });
};
