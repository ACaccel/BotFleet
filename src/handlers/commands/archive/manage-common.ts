import { ButtonStyle, type ButtonBuilder } from 'discord.js';
import type { BoundTranslate } from '../../../core/i18n';
import { button } from './presentation-common';
import { shortArchiveReference } from './manage-references';

export const manageButton = (
  action: string,
  id: string,
  label: string,
  danger = false,
): ButtonBuilder => {
  const customId = `archive_manage|${action}|${id}`;
  const result = button(
    customId.length <= 100 ? customId : `archive_manage|ref|${shortArchiveReference(action, id)}`,
    label,
  );
  if (result === undefined) throw new Error('Archive control identity exceeds Discord limit');
  return result.setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Secondary);
};

export const manageBack = (kind: 'jobs' | 'plans', t: BoundTranslate): ButtonBuilder =>
  manageButton(kind, 'first', t(`replies:archive.manage_back_${kind}`));
