import type { Translator } from '../i18n';
import type { ArchiveProgressSnapshot, ArchivePhaseProgress } from './progress';
import { sanitizeArchiveProgress } from './progress';
import { renderArchiveProgressPage } from './progress-page-renderer';

const escapeName = (value: string): string =>
  value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1').replace(/@/g, '@\u200b');
const number = (value: number): string =>
  Math.max(0, value).toLocaleString('en-US', {
    maximumFractionDigits: 1,
    ...(value > Number.MAX_SAFE_INTEGER ? { notation: 'scientific' } : {}),
  });
const seconds = (value: number): number => Math.ceil(Math.max(0, value) / 1000);
const discordTime = (value: number, style: 'f' | 'R' = 'f'): string =>
  `<t:${Math.floor(value / 1000)}:${style}>`;

/** Public notices expose aggregate progress; authorized panels resolve source details. */
export function renderArchiveProgress(
  snapshot: ArchiveProgressSnapshot,
  translator: Translator,
  now = Date.now(),
  options: {
    details?: boolean;
    sourcePage?: boolean;
    public?: boolean;
    target?: string;
    sourceLabels?: Readonly<Record<string, string>>;
    contextLines?: readonly string[];
    footerLines?: readonly string[];
  } = {},
): string {
  snapshot =
    sanitizeArchiveProgress(snapshot) ??
    sanitizeArchiveProgress({ phase: 'discovery', state: 'failed' })!;
  if (options.sourcePage) return renderArchiveProgressPage(snapshot, translator, options);
  const t = (key: string, values?: Record<string, string | number>): string =>
    translator.t(`replies:archive.view_${key}`, values);
  const terminal = ['complete', 'partial', 'failed', 'cancelled'].includes(snapshot.state);
  const needsAttention = ['partial', 'failed'].includes(snapshot.state);
  const hasMessageProgress =
    ['history', 'reactions'].includes(snapshot.phase) ||
    ['periodic', 'apply', 'resume'].includes(snapshot.work) ||
    snapshot.messages.scanned > 0 ||
    snapshot.sources.total > 0;
  const countersUnavailable =
    terminal &&
    snapshot.messageCountQuality === 'lower-bound' &&
    snapshot.primary === undefined &&
    Object.values(snapshot.phases).every(
      (phase) => phase.quality === 'unknown' && phase.committed === 0 && phase.scanned === 0,
    ) &&
    Object.values(snapshot.messages).every((count) => count === 0) &&
    snapshot.sources.total === 0 &&
    snapshot.reactions.required === 0;
  const state =
    snapshot.state === 'running' &&
    snapshot.activityCount > 0 &&
    snapshot.activities.length === snapshot.activityCount &&
    snapshot.activities.every((item) => item.step === 'waiting')
      ? 'waiting'
      : snapshot.state;
  const lines = [t('title', { work: t(`work_${snapshot.work}`), state: t(`state_${state}`) })];
  if (options.public) {
    if (options.target !== undefined) {
      const identity = /^(.*) \(ID (\d{1,20})\)$/.exec(options.target);
      const name = identity?.[1] ?? options.target;
      const shortened = name.length > 48 ? `${name.slice(0, 45)}...` : name;
      const target = identity?.[2] === undefined ? shortened : `${shortened} (ID ${identity[2]})`;
      lines.push(t('target', { target: escapeName(target) }));
    }
    if (state === 'queued') lines.push(t('queued', { elapsed: seconds(snapshot.elapsedMs) }));
    else lines.push(t('phase', { phase: t(`phase_${snapshot.phase}`) }));
    if (needsAttention) {
      lines.push(t(snapshot.work === 'periodic' ? 'public_scan_stopped' : 'public_stopped'));
      const reasons = new Set([
        ...snapshot.gaps.map((gap) => gap.reason),
        ...(snapshot.reason === undefined ? [] : [snapshot.reason]),
      ]);
      for (const reason of reasons) if (reason !== 'other') lines.push(t(`detail_gap_${reason}`));
      if (reasons.size === 0 || reasons.has('other')) lines.push(t('public_cause_unknown'));
      lines.push(
        t(
          `public_next_${snapshot.work === 'periodic' ? 'status' : (snapshot.nextAction ?? (['plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work) ? 'replan' : 'status'))}`,
        ),
      );
    }
    if (terminal && snapshot.work === 'periodic')
      lines.push(
        t('periodic_scope'),
        snapshot.cutoffKnown === false
          ? t('cutoff_unknown')
          : t('cutoff', { time: discordTime(Date.parse(snapshot.cutoff)) }),
      );
    if (hasMessageProgress && !countersUnavailable) {
      lines.push(
        snapshot.sources.quality === 'discovered' && snapshot.sources.total > 0
          ? t('source_summary', {
              count: number(snapshot.sources.completed),
              total: number(snapshot.sources.total),
            })
          : t('source_unknown', { count: number(snapshot.sources.completed) }),
        t('message_summary', { count: number(snapshot.messages.scanned) }),
      );
      if (terminal)
        lines.push(
          t('writes', {
            inserted: number(snapshot.messages.inserted),
            updated: number(snapshot.messages.updated),
            unchanged: number(snapshot.messages.unchanged),
          }),
        );
    } else if (countersUnavailable) lines.push(t('counts_unavailable'));
    if (
      ['apply', 'resume'].includes(snapshot.work) &&
      snapshot.phases.repair.unit === 'operations' &&
      snapshot.phases.repair.committed > 0
    )
      lines.push(
        t('operation_summary', {
          count: number(snapshot.phases.repair.committed),
          unit: t('unit_operations'),
        }),
      );
    if (snapshot.reactions.required > 0)
      lines.push(
        t('reaction_summary', {
          count: number(snapshot.reactions.completed),
          total: number(snapshot.reactions.required),
        }),
      );
    if (terminal && ['apply', 'resume', 'verify', 'accept'].includes(snapshot.work)) {
      lines.push(t(`validation_${snapshot.validation?.state ?? 'unavailable'}`));
      if (snapshot.validation?.coverage !== undefined)
        lines.push(t(`coverage_${snapshot.validation.coverage}`));
      lines.push(
        snapshot.cutoffKnown === false
          ? t('cutoff_unknown')
          : t('cutoff', { time: discordTime(Date.parse(snapshot.cutoff)) }),
      );
    }
    lines.push(
      t('scope', {
        count:
          snapshot.gapCountKnown === false
            ? t('unknown')
            : snapshot.gapCount === 0
              ? t('none_reported')
              : number(snapshot.gapCount),
      }),
    );
    if (state === 'cancelling' || state === 'cancelled') lines.push(t('cancelled_writes'));
    lines.push(t('private_details'));
    const footer = snapshot.jobId === undefined ? '' : t('job_id', { id: snapshot.jobId });
    return `${lines.join('\n')}${footer ? `\n\n${footer}` : ''}`;
  }
  if (options.target !== undefined) lines.push(t('target', { target: escapeName(options.target) }));
  if (['periodic', 'apply', 'resume', 'verify', 'accept'].includes(snapshot.work))
    lines.push(
      snapshot.cutoffKnown === false
        ? t('cutoff_unknown')
        : t('cutoff', { time: discordTime(Date.parse(snapshot.cutoff)) }),
    );
  lines.push(...(options.contextLines ?? []).slice(0, 3));
  const source = (sourceId: string | undefined, name?: string): string => {
    const resolved = sourceId === undefined ? undefined : options.sourceLabels?.[sourceId];
    return escapeName(
      resolved ??
        (name
          ? t('source_recorded', { name, id: sourceId ?? t('unknown') })
          : t('source_unknown_identity', { id: sourceId ?? t('unknown') })),
    );
  };
  const problems = (): string[] => {
    const rows = [
      t('scope', {
        count:
          snapshot.gapCountKnown === false
            ? t('unknown')
            : snapshot.gapCount === 0
              ? t('none_reported')
              : number(snapshot.gapCount),
      }),
    ];
    for (const gap of snapshot.gaps)
      rows.push(
        t('scope_row', {
          source: source(gap.sourceId, gap.name),
          reason: t(`gap_${gap.reason}`),
        }),
      );
    if (snapshot.gapCount > snapshot.gaps.length)
      rows.push(t('omitted', { count: snapshot.gapCount - snapshot.gaps.length }));
    return rows;
  };
  if (needsAttention) {
    const [scope, ...gaps] = problems();
    lines.push('', scope!);
    lines.push(
      t(
        `next_${snapshot.work === 'refresh-attachment' ? 'attachment' : (snapshot.nextAction ?? (['plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work) ? 'replan' : 'status'))}`,
      ),
    );
    lines.push(...gaps);
  }
  if (snapshot.state === 'cancelled') lines.push('', t('cancelled_writes'), t('next_status'));
  if (snapshot.state === 'cancelling') lines.push('', t('draining'), t('cancelled_writes'));
  if (snapshot.work === 'rollback') lines.push('', t('rollback_impact'));
  if (snapshot.state === 'queued') {
    lines.push('', t('queued', { elapsed: seconds(snapshot.elapsedMs) }), t('next_queued'));
  } else {
    lines.push('', t('phase', { phase: t(`phase_${snapshot.phase}`) }));
    if (snapshot.substep !== snapshot.phase)
      lines.push(t('substep', { step: t(`substep_${snapshot.substep}`) }));
    const countLine = (
      label: string,
      phase: ArchivePhaseProgress,
      numerator = phase.committed,
    ): string => {
      const unit = t(`unit_${phase.unit}`);
      if (options.details && phase.quality === 'estimated' && phase.referenceTotal !== undefined)
        lines.push(t('reference_total', { count: number(phase.referenceTotal), unit }));
      if (phase.total !== undefined && ['exact', 'discovered'].includes(phase.quality)) {
        const ratio = phase.total === 0 ? 100 : Math.min(100, (100 * numerator) / phase.total);
        return t('count_known', {
          label: t(label),
          count: number(numerator),
          total: number(phase.total),
          unit,
          percent: number(ratio),
        });
      }
      return t('count_unknown', { label: t(label), count: number(numerator), unit });
    };
    if (snapshot.work === 'refresh-attachment') {
      if (snapshot.state === 'complete') lines.push(t('attachment_complete'));
      else lines.push(t(terminal ? 'attachment_incomplete' : 'attachment_pending'));
      if (options.details) lines.push(countLine('attachment_steps', snapshot.phases.repair));
    } else if (countersUnavailable) lines.push(t('counts_unavailable'));
    else if (hasMessageProgress) {
      if (snapshot.sources.quality === 'discovered' && snapshot.sources.total > 0)
        lines.push(
          t('source_progress', {
            count: number(snapshot.sources.completed),
            total: number(snapshot.sources.total),
            percent: number(
              Math.min(100, (snapshot.sources.completed / snapshot.sources.total) * 100),
            ),
          }),
        );
      else lines.push(t('source_unknown', { count: number(snapshot.sources.completed) }));
      lines.push(
        countLine(
          'messages_scanned',
          snapshot.messageCountQuality === 'exact'
            ? snapshot.phases.history
            : { ...snapshot.phases.history, quality: 'unknown' },
          snapshot.messages.scanned,
        ),
      );
      if (options.details)
        lines.push(
          t('policy', {
            admitted: number(snapshot.messages.admitted),
            excluded: number(snapshot.messages.excluded),
          }),
          t('durable', {
            durable: number(snapshot.messages.durable),
            pending: number(Math.max(0, snapshot.messages.admitted - snapshot.messages.durable)),
          }),
        );
      else if (snapshot.messages.excluded > 0)
        lines.push(t('excluded', { count: number(snapshot.messages.excluded) }));
      if (terminal || options.details)
        lines.push(
          t('writes', {
            inserted: number(snapshot.messages.inserted),
            updated: number(snapshot.messages.updated),
            unchanged: number(snapshot.messages.unchanged),
          }),
        );
      if (snapshot.messageCountQuality === 'lower-bound') lines.push(t('counts_lower_bound'));
    } else {
      const phase = snapshot.phases[snapshot.phase];
      if (snapshot.primary !== undefined && snapshot.primary.unit !== phase.unit)
        lines.push(
          countLine(
            snapshot.primary.unit === 'documents' ? 'records_checked' : 'operations',
            snapshot.primary,
            snapshot.primary.unit === 'documents'
              ? snapshot.primary.scanned
              : snapshot.primary.committed,
          ),
        );
      const scanning =
        ['audit', 'plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work) &&
        phase.unit === 'documents';
      lines.push(
        countLine(
          scanning ? 'records_checked' : phase.unit === 'operations' ? 'operations' : 'checks',
          phase,
          scanning ? phase.scanned : phase.committed,
        ),
      );
    }
    if (
      snapshot.candidates !== undefined &&
      ['plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work)
    )
      lines.push(
        t('candidates', {
          timestamps: number(snapshot.candidates.timestamps),
          duplicates: number(snapshot.candidates.duplicates),
          excluded: number(snapshot.candidates.excluded),
        }),
      );
    if (snapshot.outcomes !== undefined)
      lines.push(
        t('rollback', {
          restored: number(snapshot.outcomes.restored),
          conflicts: number(snapshot.outcomes.conflicts),
          skipped: number(snapshot.outcomes.skipped),
        }),
      );
    if (snapshot.reactions.required > 0)
      lines.push(
        t('reaction_progress', {
          count: number(snapshot.reactions.completed),
          total: number(snapshot.reactions.required),
          percent: number(
            Math.min(100, (snapshot.reactions.completed / snapshot.reactions.required) * 100),
          ),
        }),
      );
    else if (['periodic', 'apply', 'resume'].includes(snapshot.work))
      lines.push(
        t(
          snapshot.reactionCountKnown === false || snapshot.messageCountQuality === 'lower-bound'
            ? 'reactions_unrecorded'
            : 'reactions_none',
        ),
      );
    if (terminal && ['apply', 'resume', 'verify', 'accept'].includes(snapshot.work)) {
      const validation = snapshot.validation;
      lines.push(t(`validation_${validation?.state ?? 'unavailable'}`));
      if (validation?.coverage !== undefined) lines.push(t(`coverage_${validation.coverage}`));
      if (validation?.recoveryExpiresAt !== undefined)
        lines.push(t('recovery_expiry', { time: discordTime(validation.recoveryExpiresAt) }));
      if (options.details && validation?.checks !== undefined)
        lines.push(
          t('validation_checks', {
            pending: number(validation.checks.pendingOperations),
            unresolved: number(validation.checks.unresolvedEvidence),
            invalid: number(validation.checks.invalidOperations),
            dependencies: number(validation.checks.missingDependencies),
          }),
        );
    }
    if (terminal && snapshot.work === 'periodic') lines.push(t('periodic_scope'));
    if (options.details && snapshot.live !== undefined)
      lines.push(
        t('live', {
          count: number(snapshot.live.pending),
          lag: seconds(snapshot.live.oldestAgeMs),
        }),
      );
    if ((!terminal || options.details) && snapshot.activities.length > 0) {
      lines.push('', t(terminal ? 'recorded_sources' : 'activities'));
      for (const activity of snapshot.activities) {
        let step = t(`step_${activity.step}`);
        if (activity.step === 'waiting' && activity.retryAt !== undefined && activity.retryAt > now)
          step += t('retry', { seconds: seconds(activity.retryAt - now) });
        if (options.details && activity.provisional && activity.pageTotal !== undefined)
          step += t('provisional', {
            count: number(activity.pageProcessed ?? 0),
            total: number(activity.pageTotal),
          });
        lines.push(
          t(options.details ? 'activity' : 'activity_summary', {
            source: source(activity.sourceId, activity.name),
            step,
            count: number(activity.scanned),
          }),
        );
        if (options.details && activity.cursor !== undefined)
          lines.push(t('cursor', { cursor: activity.cursor }));
      }
      if (snapshot.activityCount > snapshot.activities.length)
        lines.push(
          t('other_activities', { count: snapshot.activityCount - snapshot.activities.length }),
        );
    }
  }
  if (!needsAttention && snapshot.state !== 'queued') lines.push('', ...problems());
  if (snapshot.state === 'paused' && snapshot.reason !== undefined)
    lines.push(
      t('paused_reason', {
        reason: t(`gap_${snapshot.reason}`),
        elapsed: seconds(snapshot.pausedMs),
      }),
      t('next_status'),
    );
  if (snapshot.state === 'complete') {
    if (snapshot.work === 'accept') lines.push(t('next_accepted'));
    else if (['plan', 'backfill', 'migrate-timestamp'].includes(snapshot.work))
      lines.push(t('next_review_plan'));
    else if (snapshot.work === 'audit') lines.push(t('next_audit'));
    else if (
      snapshot.validation?.state === 'passed' ||
      ['apply', 'resume', 'verify'].includes(snapshot.work)
    )
      lines.push(t('next_review_result'));
    else if (!['periodic', 'refresh-attachment'].includes(snapshot.work))
      lines.push(t('next_status'));
  }
  lines.push(
    '',
    options.details
      ? t('timing', {
          elapsed: seconds(snapshot.elapsedMs),
          active: seconds(snapshot.activeMs),
          paused: seconds(snapshot.pausedMs),
        })
      : t('elapsed', { elapsed: seconds(snapshot.elapsedMs) }),
  );
  if (!terminal && snapshot.state !== 'queued') {
    const estimate = snapshot.estimate ?? snapshot.phaseEstimate;
    lines.push(
      estimate === undefined
        ? t('eta_unknown')
        : t(estimate.scope === 'run' ? 'eta_run' : 'eta_phase', {
            lower: seconds(estimate.lowerMs),
            upper: seconds(estimate.upperMs),
          }),
    );
    if (options.details)
      lines.push(t('last_progress', { elapsed: seconds(now - snapshot.lastProgressAt) }));
  } else if (snapshot.nextRunAt !== undefined && snapshot.nextRunAt > 0)
    lines.push(t('next_run', { time: discordTime(snapshot.nextRunAt) }));
  if (options.details && snapshot.updatedAt > 0)
    lines.push(t('updated', { time: discordTime(snapshot.updatedAt, 'R') }));
  const identifiers = [
    snapshot.jobId === undefined ? undefined : t('job_id', { id: snapshot.jobId }),
    snapshot.scanId === undefined ? undefined : t('scan_id', { id: snapshot.scanId }),
    snapshot.runId === undefined ? undefined : t('run_id', { id: snapshot.runId }),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
  const extras = (options.footerLines ?? []).slice(0, 3).map((line) => line.slice(0, 300));
  const footer = [identifiers, ...extras].filter(Boolean).join('\n');
  const content = `${lines.join('\n')}${footer ? `\n\n${footer}` : ''}`;
  if (content.length <= 1900) return content;
  const required = new Set([
    lines[0],
    t('phase', { phase: t(`phase_${snapshot.phase}`) }),
    ...(options.target === undefined ? [] : [t('target', { target: escapeName(options.target) })]),
    ...(options.contextLines ?? []),
    snapshot.cutoffKnown === false
      ? t('cutoff_unknown')
      : t('cutoff', { time: discordTime(Date.parse(snapshot.cutoff)) }),
    t('writes', {
      inserted: number(snapshot.messages.inserted),
      updated: number(snapshot.messages.updated),
      unchanged: number(snapshot.messages.unchanged),
    }),
    t('source_progress', {
      count: number(snapshot.sources.completed),
      total: number(snapshot.sources.total),
      percent: number(
        snapshot.sources.total === 0
          ? 0
          : Math.min(100, (snapshot.sources.completed / snapshot.sources.total) * 100),
      ),
    }),
    t('source_unknown', { count: number(snapshot.sources.completed) }),
    ...lines.filter((line) => line.startsWith(t('messages_scanned'))),
    t('reaction_progress', {
      count: number(snapshot.reactions.completed),
      total: number(snapshot.reactions.required),
      percent: number(
        snapshot.reactions.required === 0
          ? 0
          : Math.min(100, (snapshot.reactions.completed / snapshot.reactions.required) * 100),
      ),
    }),
    t('counts_lower_bound'),
    t('counts_unavailable'),
    t('periodic_scope'),
    t(`validation_${snapshot.validation?.state ?? 'unavailable'}`),
    ...(snapshot.validation?.coverage === undefined
      ? []
      : [t(`coverage_${snapshot.validation.coverage}`)]),
    ...(snapshot.validation?.recoveryExpiresAt === undefined
      ? []
      : [t('recovery_expiry', { time: discordTime(snapshot.validation.recoveryExpiresAt) })]),
    ...[
      'cancelled_writes',
      'draining',
      'rollback_impact',
      'next_accepted',
      'next_review_result',
      'next_review_plan',
      'next_replan',
      'next_resume',
      'next_status',
      'next_attachment',
      'next_queued',
    ].map((key) => t(key)),
    ...(snapshot.outcomes === undefined ? [] : [t('rollback', snapshot.outcomes)]),
    t('scope', {
      count:
        snapshot.gapCountKnown === false
          ? t('unknown')
          : snapshot.gapCount === 0
            ? t('none_reported')
            : number(snapshot.gapCount),
    }),
  ]);
  const selected = new Set(lines.flatMap((line, index) => (required.has(line) ? [index] : [])));
  const kept = [...selected].map((index) => lines[index]!);
  const details = t('details_sources', {
    command: snapshot.work === 'periodic' ? '/archive schedule status page:1' : '/archive jobs',
  });
  let chosenFooter = identifiers;
  for (const extra of extras) {
    const candidate = [chosenFooter, extra].filter(Boolean).join('\n');
    if ([...kept, details, candidate].join('\n').length + 2 <= 1900) chosenFooter = candidate;
  }
  const reserve = 1900 - chosenFooter.length - details.length - 3;
  for (const [index, line] of lines.entries())
    if (!selected.has(index) && [...kept, line].join('\n').length <= reserve) {
      kept.push(line);
      selected.add(index);
    }
  const result = `${[...lines.filter((_, index) => selected.has(index)), details].join('\n')}\n\n${chosenFooter}`;
  if (result.length > 1900)
    throw new Error('Archive summary exceeded its required information budget');
  return result;
}
