import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';

import {
  buildButtonRows,
  msgReact,
  scheduleJob,
} from '../../../src/handlers/commands/discord-helpers';

const scheduleJobMock = vi.fn();

vi.mock('node-schedule', () => ({
  default: {
    scheduleJob: (...args: unknown[]) => scheduleJobMock(...args),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildButtonRows', () => {
  it('returns no rows for an empty config', () => {
    expect(buildButtonRows([])).toEqual([]);
  });

  it('packs up to five buttons into a single row', () => {
    const rows = buildButtonRows(
      Array.from({ length: 5 }, (_, i) => ({ customId: `c${i}`, label: `L${i}` })),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.components).toHaveLength(5);
  });

  it('overflows into a second row beyond five buttons', () => {
    const rows = buildButtonRows(
      Array.from({ length: 7 }, (_, i) => ({ customId: `c${i}`, label: `L${i}` })),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.components).toHaveLength(5);
    expect(rows[1]?.components).toHaveLength(2);
  });
});

describe('msgReact', () => {
  /** Build a fake `Message` whose `react()` behaviour the test controls. */
  const fakeMessage = (react: () => Promise<unknown>): Message =>
    ({ id: 'm1', guildId: 'g1', react }) as unknown as Message;

  it('reacts with every emoji in order', async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    await msgReact(fakeMessage(react), ['a', 'b']);

    expect(react.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('is a no-op when the reaction list is empty', async () => {
    const react = vi.fn();
    await msgReact(fakeMessage(react), []);

    expect(react).not.toHaveBeenCalled();
  });

  it('isolates a failed reaction and logs it on the operator channel', async () => {
    const react = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(undefined);
    const errorFn = vi.fn();
    const logger = { child: vi.fn().mockReturnValue({ error: errorFn }) };

    await msgReact(
      fakeMessage(react),
      ['bad', 'good'],
      logger as unknown as Parameters<typeof msgReact>[2],
      'bot-1',
    );

    // Both reactions are still attempted despite the first rejecting.
    expect(react).toHaveBeenCalledTimes(2);
    expect(errorFn).toHaveBeenCalledTimes(1);
    expect(logger.child).toHaveBeenCalledWith({ bot: 'bot-1', guildId: 'g1' });
  });

  it('does not throw when a reaction fails and no logger is supplied', async () => {
    const react = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(msgReact(fakeMessage(react), ['x'])).resolves.toBeUndefined();
  });
});

describe('scheduleJob', () => {
  it('delegates to node-schedule and returns the job', () => {
    const job = { cancel: vi.fn() };
    scheduleJobMock.mockReturnValue(job);
    const date = new Date('2030-06-01T00:00:00Z');
    const callback = () => undefined;

    const result = scheduleJob(date, callback);

    expect(result).toBe(job);
    expect(scheduleJobMock).toHaveBeenCalledWith(date, callback);
  });
});
