import { describe, expect, it } from 'vitest';
import {
  ArchiveDirtyTracker,
  ArchiveObservationScope,
} from '../../../src/plugins/message-backup/runtime/dirty-tracker';

describe('ArchiveDirtyTracker', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new ArchiveDirtyTracker(0)).toThrow(RangeError);
  });

  it('reports a change only for observations after the reader started', () => {
    const tracker = new ArchiveDirtyTracker(4);
    tracker.observe('a');
    const since = tracker.current;
    expect(tracker.changedSince('a', since)).toBe(false);
    expect(tracker.changedSince('b', since)).toBe(false);
    tracker.observe('b');
    expect(tracker.changedSince('b', since)).toBe(true);
    expect(tracker.changedSince('a', since)).toBe(false);
  });

  it('keeps readers valid when eviction drops only versions they already saw', () => {
    const tracker = new ArchiveDirtyTracker(2);
    tracker.observe('target');
    tracker.observe('other');
    const since = tracker.current;
    // Evicts `target` itself: its version predates the reader, so nothing was hidden.
    tracker.observe('fresh');
    expect(tracker.size).toBe(2);
    expect(tracker.changedSince('target', since)).toBe(false);
    expect(tracker.changedSince('unrelated', since)).toBe(false);
    expect(tracker.changedSince('fresh', since)).toBe(true);
  });

  it('invalidates absent messages once an eviction drops a version newer than the reader', () => {
    const tracker = new ArchiveDirtyTracker(2);
    const since = tracker.current;
    tracker.observe('target');
    tracker.observe('x');
    tracker.observe('y');
    // `target` changed after the reader started and was evicted; it must not look clean.
    expect(tracker.changedSince('target', since)).toBe(true);
    expect(tracker.changedSince('never-seen', since)).toBe(true);
    expect(tracker.changedSince('never-seen', tracker.current)).toBe(false);
  });

  it('settles an acknowledged version only while no reader can need it', () => {
    const tracker = new ArchiveDirtyTracker(8);
    const version = tracker.observe('a');
    tracker.settle('a', version);
    expect(tracker.size).toBe(0);

    const later = tracker.observe('b');
    tracker.observe('b');
    tracker.settle('b', later);
    // A newer observation of the same message supersedes the acknowledged one.
    expect(tracker.size).toBe(1);
  });

  it('defers settlement until an older read window closes', () => {
    const tracker = new ArchiveDirtyTracker(8);
    const read = tracker.beginRead();
    const version = tracker.observe('a');
    tracker.settle('a', version);
    expect(tracker.changedSince('a', read.since)).toBe(true);
    read.end();
    read.end();
    expect(tracker.size).toBe(0);

    const newer = tracker.beginRead();
    const after = tracker.observe('b');
    const fresh = tracker.beginRead();
    tracker.settle('b', after);
    expect(tracker.size).toBe(1);
    newer.end();
    // The remaining window started after the version, so removal is safe.
    expect(tracker.size).toBe(0);
    fresh.end();
  });

  it('defers settlement while a consumer pins the message', () => {
    const tracker = new ArchiveDirtyTracker(8);
    const since = tracker.current;
    const release = tracker.pin('a');
    const other = tracker.pin('a');
    const version = tracker.observe('a');
    tracker.settle('a', version);
    expect(tracker.changedSince('a', since)).toBe(true);
    release();
    release();
    expect(tracker.size).toBe(1);
    other();
    expect(tracker.size).toBe(0);
  });
  it('treats an evicted version equal to the reader start as already seen', () => {
    const tracker = new ArchiveDirtyTracker(1);
    tracker.observe('a');
    const since = tracker.current;
    tracker.observe('b');
    // `a` (version == since) was evicted; the floor equals since and hides nothing.
    expect(tracker.versionOf('a')).toBeUndefined();
    expect(tracker.changedSince('a', since)).toBe(false);
    tracker.observe('c');
    // `b` (version > since) was evicted; now absent messages may have changed.
    expect(tracker.changedSince('a', since)).toBe(true);
  });

  it('closes only its own window when end() repeats with another window at the same epoch', () => {
    const tracker = new ArchiveDirtyTracker(8);
    const first = tracker.beginRead();
    const second = tracker.beginRead();
    expect(first.since).toBe(second.since);
    const version = tracker.observe('a');
    tracker.settle('a', version);
    first.end();
    first.end();
    expect(tracker.held).toEqual({ reads: 1, pins: 0, settled: 1 });
    expect(tracker.size).toBe(1);
    second.end();
    expect(tracker.held).toEqual({ reads: 0, pins: 0, settled: 0 });
    expect(tracker.size).toBe(0);
  });
});

describe('ArchiveObservationScope', () => {
  it('releases what consumers left at close and late additions at once', () => {
    const tracker = new ArchiveDirtyTracker(8);
    const scope = new ArchiveObservationScope();
    const consumed = tracker.pin('a');
    const leftover = tracker.pin('b');
    scope.add(consumed);
    scope.add(leftover);
    consumed();
    scope.remove(consumed);
    expect(tracker.held.pins).toBe(1);
    scope.close();
    expect(tracker.held.pins).toBe(0);
    // A read that finishes after its scan ended must not keep its pin.
    scope.add(tracker.pin('late'));
    expect(tracker.held.pins).toBe(0);
  });
});
