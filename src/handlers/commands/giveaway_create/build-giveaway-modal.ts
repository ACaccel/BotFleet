import { LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { BaseBot } from '@bot';

/**
 * Build the giveaway-create modal. Mirrors `ai_settings`'
 * `buildSettingsModal`: it depends on Discord builder types — not pure
 * — but pulls the component assembly out of the command handler so
 * `index.ts` stays well under the 150-line cap.
 *
 * The four text inputs carry the giveaway details (duration /
 * prize / winner_num / description). `winner_num` is a free-text field
 * because modals have no numeric input type; the submit handler parses
 * and validates it.
 */
export const buildGiveawayModal = (
  translator: BaseBot['translator'],
  useConfiguredChannel = false,
): ModalBuilder => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translator?.t(key, params) ?? '';

  const durationInput = new TextInputBuilder()
    .setCustomId('duration')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(t('replies:giveaway.modal_duration_placeholder'));

  const prizeInput = new TextInputBuilder()
    .setCustomId('prize')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(t('replies:giveaway.modal_prize_placeholder'));

  const winnerInput = new TextInputBuilder()
    .setCustomId('winner_num')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(t('replies:giveaway.modal_winner_placeholder'));

  const descriptionInput = new TextInputBuilder()
    .setCustomId('description')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder(t('replies:giveaway.modal_description_placeholder'));

  return new ModalBuilder()
    .setCustomId(useConfiguredChannel ? 'giveaway_create|configured' : 'giveaway_create')
    .setTitle(t('replies:giveaway.modal_title'))
    .setLabelComponents(
      new LabelBuilder()
        .setLabel(t('replies:giveaway.modal_duration_label'))
        .setTextInputComponent(durationInput),
      new LabelBuilder()
        .setLabel(t('replies:giveaway.modal_prize_label'))
        .setTextInputComponent(prizeInput),
      new LabelBuilder()
        .setLabel(t('replies:giveaway.modal_winner_label'))
        .setTextInputComponent(winnerInput),
      new LabelBuilder()
        .setLabel(t('replies:giveaway.modal_description_label'))
        .setTextInputComponent(descriptionInput),
    );
};
