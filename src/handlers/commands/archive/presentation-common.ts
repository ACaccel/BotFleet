import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { BoundTranslate } from '../../../core/i18n';
import type { ArchiveManifestCategory } from '../../../core/archive/manifest-summary';
import type { ArchiveControlService } from '../../../infra/archive/control';
import {
  archiveNavigationId,
  type ArchiveBrowsePage,
  type ArchiveNavigationActor,
} from './navigation';

export type Manifest = Awaited<ReturnType<ArchiveControlService['manifest']>>;
export type Confirmation = Awaited<ReturnType<ArchiveControlService['requestConfirmation']>>;
export type Job = Awaited<ReturnType<ArchiveControlService['status']>>;
export type ArchiveView = 'summary' | 'changes' | 'technical';
export const archiveCategories: readonly ArchiveManifestCategory[] = [
  'reset-progress',
  'remove-duplicate-progress',
  'repair-message-time',
  'merge-duplicate-messages',
  'exclude-by-policy',
  'quarantine-data',
  'unknown',
];
const views = { summary: 's', changes: 'c', technical: 't' } as const;
export const runStates = new Set([
  'planning',
  'planned',
  'partial-plan',
  'failed-plan',
  'applying',
  'enriching',
  'verifying',
  'complete',
  'partial',
  'accepted',
  'rolling-back',
  'rollback-conflicts',
  'rolled-back',
  'recovery-expired',
]);
export const date = (value: number, style = 'f'): string =>
  `<t:${Math.floor(value / 1000)}:${style}>`;
export const rows = (buttons: readonly ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] => {
  const result: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5)
    result.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)),
    );
  return result;
};
export const button = (customId: string, label: string): ButtonBuilder | undefined =>
  customId.length > 100
    ? undefined
    : new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Secondary);
export const present = (value: ButtonBuilder | undefined): value is ButtonBuilder =>
  value !== undefined;
export const archivePanelButton = (jobId: string, label: string): ButtonBuilder | undefined =>
  button(`archive_panel|${jobId}`, label);
export const archiveViewId = (
  runId: string,
  view: ArchiveView,
  direction = 'a',
  sequence = -1,
  category?: ArchiveManifestCategory,
): string =>
  `archive_view|${runId}|${views[view]}|${direction}|${sequence}|${category === undefined ? 'a' : archiveCategories.indexOf(category)}`;
export const categoryName = (t: BoundTranslate, category?: ArchiveManifestCategory): string =>
  t(`replies:archive.category_${category ?? 'all'}`);

export const escapeArchiveText = (value: string): string =>
  value.replace(/[\\`*_~|<>[\]]/g, '\\$&');
export const browseButton = (
  runId: string,
  actor: ArchiveNavigationActor,
  page: ArchiveBrowsePage,
  label: string,
): ButtonBuilder =>
  new ButtonBuilder()
    .setCustomId(archiveNavigationId(runId, actor, page))
    .setLabel(label.slice(0, 80))
    .setStyle(ButtonStyle.Secondary);
export const browseViews = (
  runId: string,
  actor: ArchiveNavigationActor,
  t: BoundTranslate,
  active: string,
): ActionRowBuilder<ButtonBuilder>[] =>
  rows(
    (['summary', 'changes'] as const)
      .filter((view) => view !== active)
      .map((view) => browseButton(runId, actor, { view }, t(`replies:archive.view_${view}`))),
  );
