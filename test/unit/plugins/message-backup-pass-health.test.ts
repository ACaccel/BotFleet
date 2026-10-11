import { describe, expect, it } from 'vitest';
import {
  archivePassHealth,
  type PeriodicPassResult,
} from '../../../src/plugins/message-backup/runtime/periodic-pass';

describe('periodic pass health', () => {
  it.each<[string, PeriodicPassResult | undefined, ReturnType<typeof archivePassHealth>]>([
    ['complete, gaps included', { outcome: { kind: 'complete' } }, { kind: 'success' }],
    ['interrupted', { outcome: { kind: 'interrupted' } }, { kind: 'neutral' }],
    [
      'blocked by failures',
      { outcome: { kind: 'partial' }, reason: 'permission' },
      { kind: 'failure', reason: 'permission' },
    ],
    [
      'thrown',
      {
        outcome: { kind: 'failed', consecutiveFailures: 2 },
        error: new Error('x'),
        reason: 'capacity',
      },
      { kind: 'failure', reason: 'capacity' },
    ],
    [
      'skipped in capture-only mode',
      { outcome: { kind: 'skipped' } },
      { kind: 'failure', reason: 'other' },
    ],
    ['rejected outside its handling', undefined, { kind: 'failure', reason: 'other' }],
  ])('classifies a pass that was %s', (_case, pass, health) => {
    expect(archivePassHealth(pass)).toEqual(health);
  });
});
