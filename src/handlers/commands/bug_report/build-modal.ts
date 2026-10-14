import {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { BaseBot } from '@bot';

const TYPES = ['bug', 'suggestion', 'other'] as const;

/** The report form: type, title (100) and content (1000). */
export const buildBugReportModal = (translator: BaseBot['translator']): ModalBuilder => {
  const t = (key: string): string => translator?.t(`replies:bug_report.${key}`) ?? '';
  const type = new StringSelectMenuBuilder()
    .setCustomId('type')
    .setRequired(true)
    .addOptions(
      TYPES.map((value) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(t(`type_${value}`))
          .setValue(value)
          .setDefault(value === 'bug'),
      ),
    );
  const title = new TextInputBuilder()
    .setCustomId('title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  const content = new TextInputBuilder()
    .setCustomId('content')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000)
    .setPlaceholder(t('modal_content_placeholder'));
  return new ModalBuilder()
    .setCustomId('bug_report')
    .setTitle(t('modal_title'))
    .setLabelComponents(
      new LabelBuilder().setLabel(t('modal_type_label')).setStringSelectMenuComponent(type),
      new LabelBuilder().setLabel(t('modal_title_label')).setTextInputComponent(title),
      new LabelBuilder().setLabel(t('modal_content_label')).setTextInputComponent(content),
    );
};
