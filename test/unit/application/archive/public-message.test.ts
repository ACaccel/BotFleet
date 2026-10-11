import { describe, expect, it } from 'vitest';
import { withArchivePublicMessageLock } from '../../../../src/application/archive/public-message';

describe('public archive message coordination', () => {
  it('continues queued edits after an earlier edit fails', async () => {
    let release!: () => void;
    let enter!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const calls: string[] = [];
    const failed = withArchivePublicMessageLock('10', '100', async () => {
      calls.push('first');
      enter();
      await blocked;
      throw new Error('delivery unavailable');
    });
    const recovered = withArchivePublicMessageLock('10', '100', async () => {
      calls.push('second');
    });
    const rejection = expect(failed).rejects.toThrow('delivery unavailable');
    await entered;
    expect(calls).toEqual(['first']);
    release();
    await rejection;
    await recovered;
    expect(calls).toEqual(['first', 'second']);
  });
});
