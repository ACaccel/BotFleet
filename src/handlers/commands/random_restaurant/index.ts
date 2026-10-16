import type { ChatInputCommandInteraction } from 'discord.js';
import { AxiosError } from 'axios';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import restaurant_types from './restaurant-types.json';

import { getJson } from '../../../infra/http';
import { getOptionalNumber, getOptionalString } from '../../../infra/discord/options';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { parseRandomRestaurantConfig } from './config';
import { RecommendResponseSchema } from './response';

/** The status the recommendation API returns when nothing matched. */
const NO_MATCH_STATUS = 404;

/** Taipei is UTC+8; the "restaurants are closed" copy is time-of-day based. */
const TAIPEI_UTC_OFFSET_HOURS = 8;
const LATE_NIGHT_START_HOUR = 0;
const LATE_NIGHT_END_HOUR = 6;

export default class random_restaurant extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'random_restaurant',
      category: 'utility',
      options: {
        string: [
          {
            name: 'type',
            required: false,
            // Restaurant-type choices live in the colocated
            // `restaurant-types.json` data file so the CJK
            // choice strings stay out of this `.ts` source.
            // `name` and `value` are kept identical because
            // the food API matches the request `type`
            // parameter against these exact strings.
            choices: restaurant_types.map((type) => ({
              name: type,
              value: type,
            })),
          },
          { name: 'name_keyword', required: false, maxLength: 100 },
          { name: 'address_keyword', required: false, maxLength: 100 },
        ],
        integer: [{ name: 'budget', required: false, min: 0, max: 100_000 }],
        float: [
          { name: 'min_rating', required: false, min: 0, max: 5 },
          { name: 'max_rating', required: false, min: 0, max: 5 },
        ],
      },
    });
  }

  /**
   * The endpoint has no default — silently probing a hard-coded third
   * party is exactly what this change removes — so an enabled command
   * without the block fails at registration instead.
   */
  public override validateBotConfig(botConfig: unknown): void {
    parseRandomRestaurantConfig(botConfig);
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(key, params) ?? '';
    try {
      const { apiUrl } = parseRandomRestaurantConfig(bot.config);
      const result = await getJson(apiUrl, RecommendResponseSchema, {
        params: {
          type: getOptionalString(interaction, 'type'),
          name_keyword: getOptionalString(interaction, 'name_keyword'),
          addr_keyword: getOptionalString(interaction, 'address_keyword'),
          budget: getOptionalNumber(interaction, 'budget'),
          min_rating: getOptionalNumber(interaction, 'min_rating'),
          max_rating: getOptionalNumber(interaction, 'max_rating'),
        },
      });

      const restaurant = result.restaurant;
      if (restaurant === null || restaurant === undefined) {
        await this.replyNoMatch(interaction, t);
        return;
      }

      const { address, phone, price, google_maps_link: map } = restaurant;
      await interaction.editReply({
        content: t('replies:random_restaurant.description', {
          message: result.message ?? t('replies:random_restaurant.no_description'),
          priceLine: price ? t('replies:random_restaurant.price_line', { price }) : '',
          addressLine: address ? t('replies:random_restaurant.address_line', { address }) : '',
          phoneLine: phone ? t('replies:random_restaurant.phone_line', { phone }) : '',
          mapLine: map ? t('replies:random_restaurant.map_line', { map }) : '',
        }),
      });
    } catch (error) {
      // Only the upstream's own "nothing matched" answer is a domain
      // outcome. Everything else — transport failure, a changed
      // response shape, a missing config block — reaches the error
      // boundary, so an outage stops looking like an empty result set.
      if (error instanceof AxiosError && error.response?.status === NO_MATCH_STATUS) {
        await this.replyNoMatch(interaction, t);
        return;
      }
      await replyForError(
        interaction,
        bot,
        error,
        'replies:random_restaurant.failed',
        interaction.guild?.id,
      );
    }
  }

  /** Answer an empty result set, with late-night copy after midnight in Taipei. */
  private async replyNoMatch(
    interaction: ChatInputCommandInteraction,
    t: (key: string) => string,
  ): Promise<void> {
    const hourTPE = (new Date().getUTCHours() + TAIPEI_UTC_OFFSET_HOURS) % 24;
    const lateNight = hourTPE >= LATE_NIGHT_START_HOUR && hourTPE < LATE_NIGHT_END_HOUR;
    await interaction.editReply({
      content: lateNight
        ? t('replies:random_restaurant.midnight')
        : t('replies:random_restaurant.no_match'),
    });
  }
}
