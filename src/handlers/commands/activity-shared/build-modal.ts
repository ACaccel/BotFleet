import { LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { BaseBot } from '@bot';

/** Modal custom ID; the chosen role, if any, rides in the second segment. */
const ACTIVITY_MODAL = 'activity_create';

/** The `/activity create` form; lengths keep the post within Discord's embed limits. */
export const buildActivityModal = (
  translator: BaseBot['translator'],
  roleId: string | undefined,
): ModalBuilder => {
  const t = (key: string): string => translator?.t(`replies:activity.${key}`) ?? '';
  const input = (id: string, style: TextInputStyle, required: boolean, max: number) =>
    new TextInputBuilder()
      .setCustomId(id)
      .setStyle(style)
      .setRequired(required)
      .setMaxLength(max)
      .setPlaceholder(t(`modal_${id}_placeholder`));
  const label = (id: string, component: TextInputBuilder) =>
    new LabelBuilder().setLabel(t(`modal_${id}_label`)).setTextInputComponent(component);
  return new ModalBuilder()
    .setCustomId(roleId === undefined ? ACTIVITY_MODAL : `${ACTIVITY_MODAL}|${roleId}`)
    .setTitle(t('modal_title'))
    .setLabelComponents(
      label('title', input('title', TextInputStyle.Short, true, 100)),
      label('description', input('description', TextInputStyle.Paragraph, false, 1000)),
      label('start', input('start', TextInputStyle.Short, false, 20)),
      label('deadline', input('deadline', TextInputStyle.Short, true, 10)),
      label('capacity', input('capacity', TextInputStyle.Short, false, 3)),
    );
};
