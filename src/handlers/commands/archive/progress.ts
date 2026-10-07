import type { ChatInputCommandInteraction, Guild } from 'discord.js';
import type { BaseBot } from '@bot';
import type { ArchiveProgressSnapshot } from '../../../core/archive/progress';
import { renderArchiveProgress } from '../../../core/archive/progress-renderer';
import { renderArchivePublicStatus } from '../../../core/archive/public-status-renderer';
import type { ArchiveControlService } from '../../../infra/archive/control';
import { ArchiveAccessError } from './access';
import { archiveGuildLabel, archiveSourceLabel } from './source-presentation';
import { bindTranslator } from '../../../core/i18n';

export const archiveStatusPage = (interaction: ChatInputCommandInteraction): number | null => {
  const page = interaction.options.getInteger('page');
  if (page !== null && (!Number.isSafeInteger(page) || page < 1 || page > 100_000))
    throw new ArchiveAccessError('replies:archive.invalid_input');
  return page;
};

/** Public detail pages never use retained source names without a current audience check. */
export const renderArchiveStatus = async (
  snapshot: ArchiveProgressSnapshot,
  bot: BaseBot,
  control: ArchiveControlService,
  scopeId: string,
  page: number | null,
  footerLines: readonly string[] = [],
  context: {
    guildId?: string;
    guild?: Guild | null;
    contextLines?: readonly string[];
    loadedDetails?: Awaited<ReturnType<ArchiveControlService['progressDetails']>>;
  } = {},
): Promise<string> => {
  const translator = bot.translator;
  if (translator === undefined) return 'replies:archive.view_title';
  const guild = context.guild ?? bot.client?.guilds?.cache.get(context.guildId ?? '');
  let view = snapshot;
  const footers = [...footerLines];
  if (page !== null) {
    const details = context.loadedDetails ?? (await control.progressDetails(scopeId, page, 1));
    view = {
      ...snapshot,
      activities: details.activities.slice(0, 3),
      gaps: details.gaps.slice(0, 3),
    };
    footers.push(
      translator.t(
        details.hasNext ? 'replies:archive.progress_page_next' : 'replies:archive.progress_page',
        { page: details.page, nextPage: details.page + 1 },
      ),
    );
    if (details.activities.length === 0 && details.gaps.length === 0)
      footers.push(translator.t('replies:archive.progress_page_empty'));
  }
  const t = bindTranslator(translator);
  const sourceLabels = Object.fromEntries(
    [...view.activities, ...view.gaps].flatMap((source) =>
      source.sourceId === undefined
        ? []
        : [
            [
              source.sourceId,
              archiveSourceLabel(
                { channelId: source.sourceId, historicalName: source.name },
                guild,
                t,
                page === null ? 70 : 12,
              ),
            ],
          ],
    ),
  );
  view = {
    ...view,
    activities: view.activities.map((activity) => ({ ...activity, name: '' })),
    gaps: view.gaps.map(({ name: _name, ...gap }) => gap),
  };
  if (page === null && translator !== undefined) {
    const card = renderArchivePublicStatus(view, translator);
    return [
      card.title,
      card.description,
      ...(context.contextLines ?? []),
      ...(card.fields ?? []).map((field) => `${field.name}\n${field.value}`),
      ...footers,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return renderArchiveProgress(view, translator, Date.now(), {
    details: page !== null,
    sourcePage: page !== null,
    sourceLabels,
    contextLines: context.contextLines,
    footerLines: footers,
    ...(context.guildId === undefined
      ? {}
      : { target: archiveGuildLabel(guild, context.guildId, page === null ? 100 : 12) }),
  });
};
