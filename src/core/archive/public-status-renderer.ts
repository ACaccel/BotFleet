import type { APIEmbed } from 'discord.js';
import type { Translator, TranslationParams } from '../i18n';
import type { ArchivePhaseProgress, ArchiveProgressSnapshot } from './progress';
import { sanitizeArchiveProgress } from './progress';

interface ArchivePublicStatusOptions {
  /** Resolve this label against the audience's current source access before rendering. */
  currentSource?: string;
  nowMs?: number;
  /** A publication candidate becomes the successful update time only after Discord accepts it. */
  lastSuccessfulUpdateAtMs?: number;
}

const terminalStates = new Set(['complete', 'partial', 'failed', 'cancelled']);
const number = (value: number): string =>
  value.toLocaleString('en-US', {
    maximumFractionDigits: 1,
    ...(value > Number.MAX_SAFE_INTEGER ? { notation: 'scientific' } : {}),
  });
const seconds = (value: number): number => Math.ceil(Math.max(0, value) / 1000);
const duration = (value: unknown, translator: Translator): string => {
  const t = (key: string, params?: TranslationParams): string =>
    translator.t(`replies:archive.public_duration_${key}`, params);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return t('unknown');
  const total = seconds(value);
  if (total < 60) return t('seconds', { seconds: number(total) });
  if (total < 3600)
    return t('minutes', { minutes: number(Math.floor(total / 60)), seconds: number(total % 60) });
  return t('hours', {
    hours: number(Math.floor(total / 3600)),
    minutes: number(Math.floor((total % 3600) / 60)),
  });
};
const time = (value: number): string => `<t:${Math.floor(value / 1000)}:f>`;
const sourceName = (value: string): string => {
  const plain = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? ' '
      : character;
  }).join('');
  const bounded = Array.from(plain).slice(0, 120).join('');
  const escaped = bounded.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1').replace(/@/g, '@\u200b');
  return `${escaped}${bounded === plain ? '' : '…'}`;
};

/** The compact public card contains aggregate facts and explicitly audience-safe source labels. */
export function renderArchivePublicStatus(
  progress: ArchiveProgressSnapshot,
  translator: Translator,
  options: ArchivePublicStatusOptions = {},
): APIEmbed {
  const snapshot =
    sanitizeArchiveProgress(progress) ??
    sanitizeArchiveProgress({ phase: 'discovery', state: 'failed' })!;
  const now = options.nowMs ?? Date.now();
  const t = (key: string, values?: TranslationParams): string =>
    translator.t(`replies:archive.${key}`, values);
  const view = (key: string, values?: TranslationParams): string => t(`view_${key}`, values);
  const terminal = terminalStates.has(snapshot.state);
  const waiting =
    snapshot.state === 'running' &&
    snapshot.activityCount > 0 &&
    snapshot.activities.length === snapshot.activityCount &&
    snapshot.activities.every((activity) => activity.step === 'waiting');
  const state = waiting ? 'waiting' : snapshot.state;
  const pending = ['queued', 'waiting', 'paused'].includes(state);
  const stopped = ['partial', 'failed', 'cancelled'].includes(state);
  const description = [
    t('public_phase', {
      phase: state === 'queued' ? t('public_not_started') : view(`phase_${snapshot.phase}`),
    }),
  ];
  if (!terminal) {
    const activity = snapshot.activities[0];
    const details: string[] = [];
    if (['queued', 'waiting', 'paused', 'cancelling'].includes(state))
      details.push(t(`public_activity_${state}`));
    else if (activity !== undefined) details.push(view(`step_${activity.step}`));
    else
      details.push(
        view(
          snapshot.substep === snapshot.phase
            ? `phase_${snapshot.phase}`
            : `substep_${snapshot.substep}`,
        ),
      );
    if (state !== 'queued' && options.currentSource?.trim())
      details.push(sourceName(options.currentSource));
    if (activity !== undefined && !pending && state !== 'cancelling') {
      if (
        activity.step === 'reactions' &&
        activity.reactionUsers !== undefined &&
        activity.reactionPages !== undefined
      )
        details.push(
          t('public_activity_memberships', {
            count: number(activity.reactionUsers),
            pages: number(activity.reactionPages),
          }),
        );
      else if (
        ['processing', 'writing', 'reactions', 'checkpoint'].includes(activity.step) &&
        activity.pageProcessed !== undefined &&
        activity.pageTotal !== undefined &&
        activity.pageTotal > 0 &&
        activity.pageProcessed <= activity.pageTotal
      )
        details.push(
          t('public_activity_page', {
            count: number(activity.pageProcessed),
            total: number(activity.pageTotal),
          }),
        );
      else if (activity.scanned > 0)
        details.push(t('public_activity_source_scanned', { count: number(activity.scanned) }));
    } else if (activity === undefined && !pending && state !== 'cancelling') {
      const phase = snapshot.phases[snapshot.phase];
      if (phase.scanned > 0 || phase.committed > 0 || phase.quality !== 'unknown')
        details.push(
          t(phase.scanned > 0 ? 'public_activity_scanned' : 'public_activity_confirmed', {
            count: number(phase.scanned > 0 ? phase.scanned : phase.committed),
            unit: view(`unit_${phase.unit}`),
          }),
        );
    }
    description.push(t('public_activity', { activity: details.join(' · ') }));
  }

  const fields: NonNullable<APIEmbed['fields']> = [];
  const hasMessageWork =
    ['periodic', 'apply', 'resume'].includes(snapshot.work) ||
    ['history', 'reactions'].includes(snapshot.phase) ||
    Object.values(snapshot.messages).some((value) => value > 0) ||
    snapshot.sources.total > 0;
  const hasProgress =
    Object.values(snapshot.messages).some((value) => value > 0) ||
    Object.values(snapshot.phases).some((phase) => phase.scanned > 0 || phase.committed > 0) ||
    snapshot.sources.completed > 0 ||
    snapshot.reactions.completed > 0;
  const unavailable =
    terminal &&
    !hasProgress &&
    snapshot.messageCountQuality === 'lower-bound' &&
    Object.values(snapshot.phases).every((phase) => phase.quality === 'unknown');
  const counters: string[] = [];
  const phaseCount = (phase: ArchivePhaseProgress, label: string, scanned = false): string => {
    const values = {
      count: number(scanned ? phase.scanned : phase.committed),
      unit: view(`unit_${phase.unit}`),
    };
    return t(label, values);
  };
  if (state !== 'queued' && (!pending || hasProgress)) {
    if (unavailable) counters.push(view('counts_unavailable'));
    else if (hasMessageWork) {
      counters.push(
        t(
          snapshot.sources.quality === 'unknown' ? 'public_sources_discovering' : 'public_sources',
          {
            count: number(snapshot.sources.completed),
            total: number(snapshot.sources.total),
          },
        ),
        t(
          snapshot.messageCountQuality === 'exact' ? 'public_messages' : 'public_messages_partial',
          {
            count: number(snapshot.messages.scanned),
          },
        ),
        t(
          snapshot.messageClassificationVersion === 2
            ? snapshot.messageCountQuality === 'exact'
              ? 'public_classified_writes'
              : 'public_classified_writes_partial'
            : snapshot.messageCountQuality === 'exact'
              ? 'public_writes'
              : 'public_writes_partial',
          {
            inserted: number(snapshot.messages.inserted),
            updated: number(snapshot.messages.updated),
            upgraded: number(snapshot.messages.upgraded ?? 0),
          },
        ),
      );
      if (snapshot.messageClassificationVersion !== 2 && (snapshot.messages.upgraded ?? 0) > 0)
        counters.push(t('public_known_upgrades', { count: number(snapshot.messages.upgraded!) }));
      counters.push(
        t('public_unchanged_excluded', {
          unchanged: number(snapshot.messages.unchanged),
          excluded: number(snapshot.messages.excluded),
        }),
      );
      if (
        snapshot.phases.repair.unit === 'operations' &&
        (snapshot.phase === 'repair' || (terminal && snapshot.phases.repair.committed > 0))
      )
        counters.push(phaseCount(snapshot.phases.repair, 'public_operations_confirmed'));
      if (
        (['history', 'reactions'].includes(snapshot.phase) || terminal) &&
        snapshot.reactionCountKnown !== false &&
        snapshot.reactions.required > 0
      )
        counters.push(
          t('public_reactions', {
            count: number(snapshot.reactions.completed),
            total: number(snapshot.reactions.required),
          }),
        );
    } else {
      const phase = snapshot.phases[snapshot.phase];
      if (snapshot.primary !== undefined && snapshot.primary.unit !== phase.unit)
        counters.push(
          phaseCount(
            snapshot.primary,
            snapshot.primary.unit === 'documents'
              ? 'public_records_scanned'
              : 'public_operations_confirmed',
            snapshot.primary.unit === 'documents',
          ),
        );
      if (phase.quality === 'unknown' && phase.scanned === 0 && phase.committed === 0)
        counters.push(view('counts_unavailable'));
      else
        counters.push(
          phaseCount(
            phase,
            phase.unit === 'documents'
              ? ['audit', 'plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work)
                ? 'public_records_scanned'
                : 'public_records_committed'
              : phase.unit === 'operations'
                ? 'public_operations_confirmed'
                : 'public_checks',
            phase.unit === 'documents' &&
              ['audit', 'plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work),
          ),
        );
      if (snapshot.candidates !== undefined)
        counters.push(
          view('candidates', {
            timestamps: number(snapshot.candidates.timestamps),
            duplicates: number(snapshot.candidates.duplicates),
            excluded: number(snapshot.candidates.excluded),
          }),
        );
      if (snapshot.outcomes !== undefined)
        counters.push(
          view('rollback', {
            restored: number(snapshot.outcomes.restored),
            conflicts: number(snapshot.outcomes.conflicts),
            skipped: number(snapshot.outcomes.skipped),
          }),
        );
    }
    if (counters.length > 0)
      fields.push({
        name: t('public_progress'),
        value: counters.map((line) => `• ${line}`).join('\n'),
      });
  }

  const guidance: string[] = [];
  const reason = snapshot.reason ?? snapshot.gaps[0]?.reason ?? 'other';
  if (state === 'queued') guidance.push(t('public_queued'));
  else if (pending) {
    guidance.push(
      state === 'waiting'
        ? t('public_waiting')
        : t('public_paused', { reason: t(`public_reason_${reason}`) }),
    );
    const waitSince = snapshot.activities.reduce(
      (earliest, activity) =>
        activity.waitSince === undefined ? earliest : Math.min(earliest, activity.waitSince),
      now,
    );
    guidance.push(
      t('public_wait_duration', {
        elapsed: duration(Math.max(snapshot.pausedMs, now - waitSince), translator),
      }),
    );
  } else if (state === 'cancelling') guidance.push(view('draining'), view('cancelled_writes'));
  if (stopped) {
    guidance.push(
      view(snapshot.work === 'periodic' ? 'public_scan_stopped' : 'public_stopped'),
      t(state === 'cancelled' ? 'public_cancelled_reason' : `public_reason_${reason}`),
      view(
        `public_next_${
          snapshot.work === 'periodic'
            ? 'status'
            : (snapshot.nextAction ??
              (['plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work)
                ? 'replan'
                : 'status'))
        }`,
      ),
    );
  }
  if (terminal && snapshot.work === 'refresh-attachment')
    guidance.push(view(state === 'complete' ? 'attachment_complete' : 'attachment_incomplete'));
  if (state === 'complete' && ['plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work))
    guidance.push(view('next_review_plan'));
  if (state === 'complete' && snapshot.work === 'audit') guidance.push(view('next_audit'));

  const result: string[] = [];
  if (terminal) {
    if (snapshot.work === 'periodic') result.push(view('periodic_scope'));
    if (['apply', 'resume', 'verify', 'accept'].includes(snapshot.work)) {
      result.push(view(`validation_${snapshot.validation?.state ?? 'unavailable'}`));
      if (snapshot.validation?.coverage !== undefined)
        result.push(view(`coverage_${snapshot.validation.coverage}`));
      if (snapshot.validation?.recoveryExpiresAt !== undefined)
        result.push(view('recovery_expiry', { time: time(snapshot.validation.recoveryExpiresAt) }));
      if (state === 'complete')
        result.push(view(snapshot.work === 'accept' ? 'next_accepted' : 'next_review_result'));
    }
    if (['periodic', 'apply', 'resume', 'verify', 'accept'].includes(snapshot.work))
      result.push(
        snapshot.cutoffKnown === false
          ? view('cutoff_unknown')
          : view('cutoff', { time: time(Date.parse(snapshot.cutoff)) }),
      );
    if (snapshot.nextRunAt !== undefined && snapshot.nextRunAt > 0)
      result.push(view('next_run', { time: time(snapshot.nextRunAt) }));
    if (snapshot.gapCountKnown === false || snapshot.gapCount > 0)
      result.push(
        view('scope', {
          count: snapshot.gapCountKnown === false ? view('unknown') : number(snapshot.gapCount),
        }),
      );
  }
  if (guidance.length > 0) fields.push({ name: t('public_guidance'), value: guidance.join('\n') });
  if (result.length > 0) fields.push({ name: t('public_result'), value: result.join('\n') });

  if (snapshot.lastCheckpointAt !== undefined && snapshot.lastCheckpointAt > 0)
    description.push(
      t('public_checkpoint', { time: `<t:${Math.floor(snapshot.lastCheckpointAt / 1000)}:R>` }),
    );
  if (snapshot.messageCountQuality === 'lower-bound' && hasMessageWork && hasProgress)
    description.push(view('counts_lower_bound'));
  const recent = snapshot.recentThroughput;
  if (
    !terminal &&
    snapshot.state === 'running' &&
    recent !== undefined &&
    now >= recent.observedAt &&
    now - recent.observedAt <= 30_000
  )
    description.push(
      t('public_recent_throughput', {
        rate: number((recent.messages * 1000) / recent.windowMs),
        seconds: number(recent.windowMs / 1000),
      }),
    );

  const update = options.lastSuccessfulUpdateAtMs ?? now;
  const embed: APIEmbed = {
    title: view('title', { work: view(`work_${snapshot.work}`), state: view(`state_${state}`) }),
    description: description.join('\n'),
    color: stopped ? 0xc74634 : terminal ? 0x2f855a : pending ? 0xb7791f : 0x3182ce,
    fields,
    footer: {
      text: t('public_footer', { elapsed: duration(progress.elapsedMs, translator) }),
    },
    timestamp: new Date(update).toISOString(),
  };
  const length =
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (
    (embed.title?.length ?? 0) > 256 ||
    (embed.description?.length ?? 0) > 4096 ||
    (embed.footer?.text.length ?? 0) > 2048 ||
    fields.length > 25 ||
    fields.some((field) => field.name.length > 256 || field.value.length > 1024) ||
    length > 3000
  )
    throw new Error('Archive public status exceeded its bounded embed budget');
  return embed;
}
