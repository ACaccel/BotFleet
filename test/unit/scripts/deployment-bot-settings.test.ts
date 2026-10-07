import { describe, expect, it } from 'vitest';
import { validateBotSettings } from '../../../scripts/deployment/bot-settings';
import { parseArchiveSettings } from '../../../src/plugins/message-backup/config';

describe('deployment bot configuration preflight', () => {
  it('uses startup bounds for archive concurrency and notification intervals', () => {
    for (const concurrency of [1, 2, 8]) {
      for (const interval of [10]) {
        const runtime = { concurrency, progress_interval_seconds: interval };
        expect(() =>
          validateBotSettings(
            'msg-archive',
            JSON.stringify({ backup_server: ['1'], archive_runtime: runtime }),
          ),
        ).not.toThrow();
        expect(parseArchiveSettings({ backupServers: ['1'], runtime }).config).toMatchObject(
          runtime,
        );
      }
    }
    for (const runtime of [
      { concurrency: 9 },
      { concurrency: 0 },
      { progress_interval_seconds: 4 },
      { progress_interval_seconds: 5 },
      { progress_interval_seconds: 30 },
      { progress_interval_seconds: 31 },
    ]) {
      expect(() =>
        validateBotSettings(
          'msg-archive',
          JSON.stringify({ backup_server: ['1'], archive_runtime: runtime }),
        ),
      ).toThrow('Invalid config.json');
      expect(() => parseArchiveSettings({ backupServers: ['1'], runtime })).toThrow();
    }
  });

  it('rejects malformed settings without echoing confidential input', () => {
    for (const value of ['{"token":"confidential', '[]', 'null', '{"admin":42}']) {
      expect(() => validateBotSettings('tomori', value)).toThrow('Invalid config.json');
      try {
        validateBotSettings('tomori', value);
      } catch (error) {
        expect(String(error)).not.toContain('confidential');
      }
    }
    expect(() => validateBotSettings('tomori', '{"language":"custom"}')).not.toThrow();
    for (const extra of [
      { backup_interval_minutes: 0 },
      { backup_interval_minutes: 40_000 },
      { archive_policy: [] },
      { archive_runtime: { storage: { background_limit_bytes: 100_000_000_000 } } },
    ]) {
      expect(() =>
        validateBotSettings('msg-archive', JSON.stringify({ backup_server: ['1'], ...extra })),
      ).toThrow('Invalid config.json');
    }
  });
});
