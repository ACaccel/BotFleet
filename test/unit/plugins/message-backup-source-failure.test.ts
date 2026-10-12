import { describe, expect, it } from 'vitest';
import { ArchiveBackpressureError, ArchiveCapacityError } from '../../../src/core/archive/errors';
import { ArchiveJobStoppedError } from '../../../src/plugins/message-backup/runtime/job-cancellation';
import {
  ARCHIVE_SOURCE_RETRY,
  archiveSourceRetryDelay,
  classifyArchiveSourceFailure,
} from '../../../src/plugins/message-backup/runtime/source-failure';
import { ArchiveScanInterruptedError } from '../../../src/plugins/message-backup/runtime/worker-context';

const discord = (status: number, code?: number) =>
  Object.assign(new Error(`Discord ${status}`), {
    status,
    ...(code === undefined ? {} : { code }),
  });
const running = new AbortController().signal;

describe('source failure classification', () => {
  it.each([
    { name: 'ArchiveJobStoppedError', error: new ArchiveJobStoppedError(), expected: 'stopped' },
    {
      name: 'ArchiveScanInterruptedError',
      error: new ArchiveScanInterruptedError('paused'),
      expected: 'stopped',
    },
    { name: 'TypeError', error: new TypeError('x is undefined'), expected: 'defect' },
    { name: 'ReferenceError', error: new ReferenceError('y'), expected: 'defect' },
    {
      name: 'invalid response',
      error: new Error('History pagination stalled'),
      expected: 'defect',
    },
    { name: 'Discord 503', error: discord(503), expected: 'transient' },
    { name: 'Discord 429', error: discord(429), expected: 'transient' },
    {
      name: 'request timeout',
      error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      expected: 'transient',
    },
    {
      name: 'dropped connection',
      error: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
      expected: 'transient',
    },
    {
      name: 'ArchiveBackpressureError',
      error: new ArchiveBackpressureError('archive-pipeline-queue-full'),
      expected: 'transient',
    },
    {
      name: 'wrapped backpressure',
      error: new Error('page failed', {
        cause: new ArchiveBackpressureError('Archive writer queue is full'),
      }),
      expected: 'transient',
    },
    {
      name: 'ArchiveCapacityError',
      error: new ArchiveCapacityError('storage headroom exhausted'),
      expected: 'capacity',
    },
    {
      name: 'backpressure caused by capacity',
      error: new ArchiveBackpressureError('queue full'),
      cause: new ArchiveCapacityError('storage headroom exhausted'),
      expected: 'capacity',
    },
    { name: 'Discord 403 Missing Access', error: discord(403, 50001), expected: 'inaccessible' },
    { name: 'Discord Unknown Channel', error: discord(404, 10003), expected: 'inaccessible' },
  ])('classifies $name as $expected', ({ error, cause, expected }) => {
    if (cause !== undefined) Object.assign(error, { cause });
    expect(classifyArchiveSourceFailure(error, running)).toBe(expected);
  });

  it('treats any failure after the scan signal aborted as stopped', () => {
    const controller = new AbortController();
    controller.abort();
    for (const error of [discord(503), new TypeError('x'), new Error('Archive scan cancelled')])
      expect(classifyArchiveSourceFailure(error, controller.signal)).toBe('stopped');
  });
});

describe('source retry delay', () => {
  const policy = { attempts: 5, baseMs: 5_000, maxMs: 120_000 };
  it.each([
    { failed: 0, expected: 5_000 },
    { failed: 1, expected: 5_000 },
    { failed: 2, expected: 10_000 },
    { failed: 4, expected: 40_000 },
    { failed: 6, expected: 120_000 },
    { failed: 30, expected: 120_000 },
  ])('waits $expected ms after $failed failed attempts', ({ failed, expected }) => {
    expect(archiveSourceRetryDelay(failed, policy)).toBe(expected);
  });

  it('defaults to five attempts from five seconds, capped at two minutes', () => {
    expect(ARCHIVE_SOURCE_RETRY).toEqual(policy);
  });
});
