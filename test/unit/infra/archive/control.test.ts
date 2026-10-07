import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveJob } from '../../../../src/core/archive/types';
import {
  formatArchiveJobReport,
  safeArchiveJobSummary,
} from '../../../../src/infra/archive/control';

const job = (result: Record<string, unknown>): ArchiveJob => ({
  jobId: '123:synthetic-request',
  requestId: 'synthetic-request',
  guildId: '123',
  command: 'apply',
  options: {},
  runId: 'synthetic-run',
  status: 'partial',
  cancelRequested: false,
  createdAt: 123,
  result,
});

describe('archive control safe reports', () => {
  beforeEach(() => {
    // Keep clock digits from colliding with the synthetic identity leak sentinel.
    vi.spyOn(Date, 'now').mockReturnValue(2000);
  });
  afterEach(() => vi.restoreAllMocks());

  it('retains numerical progress and ETA without leaking bodies, streams, signed URLs or errors', () => {
    const summary = safeArchiveJobSummary(
      job({
        progress: {
          phase: 'history',
          state: 'running',
          elapsedMs: 1000,
          estimatedAt: 2000,
          estimating: false,
          reason: 'private failure content',
          acknowledgements: { 'private-stream': 123 },
          phases: { history: { committed: 5, scanned: 10, admitted: 7, total: 20, rates: [0.02] } },
          estimate: {
            lowerMs: 50,
            upperMs: 100,
            scope: 'run',
            reason: 'https://private.invalid?secret=value',
          },
        },
        counts: { messages: 5, ignoredKey: 123, total: NaN, restored: -1 },
        issues: [
          'Forbidden private secret',
          'ENOSPC private secret',
          'coverage incomplete private secret',
          'conflict private secret',
          'expired private secret',
          'schema changed private secret',
          { raw: 'private secret' },
        ],
        content: 'private secret',
        error: { message: 'private secret' },
      }),
    );
    expect(summary.progress).toMatchObject({
      phase: 'history',
      state: 'partial',
      phases: { history: { committed: 5, total: 20 } },
    });
    expect(summary.counts).toEqual({ messages: 5 });
    expect(summary.issueCount).toBe(8);
    expect(summary.issueCategories).toEqual([
      'permission',
      'capacity',
      'coverage',
      'conflict',
      'expired',
      'settings-changed',
      'other',
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/private|secret|ignoredKey|acknowledgements|rates/);
    const report = formatArchiveJobReport(
      job({ progress: { body: 'private' }, counts: { messages: 5 } }),
    );
    expect(JSON.parse(report)).toEqual({
      status: 'partial',
      runId: 'synthetic-run',
      counts: { messages: 5 },
      issueCount: 0,
      issueCategories: [],
    });
    expect(report.length).toBeLessThan(1600);
  });

  it('exposes validated attachment identity without request secrets or signed URLs', () => {
    const attachment = {
      ...job({ counts: { refreshed: 1 }, url: 'signed-secret' }),
      command: 'refresh-attachment' as const,
      options: {
        channelId: '111',
        messageId: '222',
        attachmentId: '333',
        url: 'signed-secret',
        userId: '444',
      },
    };
    const summary = safeArchiveJobSummary(attachment);
    expect(summary.attachment).toEqual({ channelId: '111', messageId: '222', attachmentId: '333' });
    expect(JSON.stringify(summary)).not.toMatch(/signed-secret|userId|444/);
    expect(
      safeArchiveJobSummary({
        ...attachment,
        options: { ...attachment.options, messageId: 'invalid private value' },
      }),
    ).not.toHaveProperty('attachment');
  });

  it('handles missing/malformed progress data and unavailable ETA without fabricating an estimate', () => {
    expect(
      safeArchiveJobSummary(job({ progress: { phase: 'private phase', state: 'running' } }))
        .progress,
    ).toMatchObject({ phase: 'repair', state: 'partial', estimating: false });
    const summary = safeArchiveJobSummary(
      job({
        progress: {
          phase: 'verification',
          state: 'paused',
          phaseEstimate: { lowerMs: -1, upperMs: 100, scope: 'phase' },
        },
      }),
    );
    expect(summary.progress?.estimate).toBeUndefined();
    expect(summary.progress?.phases['verification']?.committed).toBe(0);
    expect(summary.progress?.estimating).toBe(false);
    const withPhase = safeArchiveJobSummary({
      ...job({
        progress: {
          phase: 'repair',
          state: 'running',
          phaseEstimate: { lowerMs: 10, upperMs: 20, scope: 'phase' },
        },
      }),
      status: 'running',
    });
    expect(withPhase.progress?.estimate?.scope).toBe('phase');
    const invalid = job({ issues: null, counts: ['private'], runId: 'private content' });
    delete invalid.runId;
    expect(safeArchiveJobSummary(invalid)).not.toHaveProperty('runId');
  });
});
