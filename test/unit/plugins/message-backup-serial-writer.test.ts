import { describe, expect, it } from 'vitest';
import { ArchiveSerialWriter } from '../../../src/plugins/message-backup/runtime/serial-writer';
describe('archive writer drain', () => {
  it('waits for in-flight work and rejects work after stop', async () => {
    const writer = new ArchiveSerialWriter();
    let finish!: () => void;
    const order: number[] = [];
    const first = writer.run(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      order.push(1);
    });
    const second = writer.run(async () => {
      order.push(2);
    });
    await Promise.resolve();
    const stop = writer.stop();
    await expect(writer.run(async () => {})).rejects.toThrow('draining');
    expect(order).toEqual([]);
    finish();
    await Promise.all([first, second, stop]);
    expect(order).toEqual([1, 2]);
    expect(writer.snapshot()).toMatchObject({
      pending: 0,
      peakPending: 2,
      completed: 2,
      failed: 0,
    });
    expect(writer.snapshot().queueWaitMs).toBeGreaterThan(0);
    expect(writer.snapshot().drainMs).toBeGreaterThan(0);
  });
  it('does not poison following work after a failed operation', async () => {
    const writer = new ArchiveSerialWriter();
    await expect(
      writer.run(async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(writer.run(async () => 3)).resolves.toBe(3);
    expect(writer.snapshot()).toMatchObject({ pending: 0, completed: 1, failed: 1 });
  });
});
