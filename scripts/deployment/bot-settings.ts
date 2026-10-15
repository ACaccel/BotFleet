import { z } from 'zod';
import { parseArchiveSettings } from '../../src/plugins/message-backup/config';
import { NotificationRoutesSchema } from '../../src/plugins/notification-relay/internal/config';

const settings = z
  .object({
    admin: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    language: z.string().optional(),
    guilds: z
      .record(
        z
          .object({
            channels: z.record(z.string()).optional(),
            roles: z.record(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const konataSettings = settings.extend({
  notificationRoutes: NotificationRoutesSchema.optional(),
});

const archiveSettings = settings.extend({
  backup_server: z.array(z.string().regex(/^\d+$/)),
  backup_interval_minutes: z.number().positive().optional(),
  backup_log_enabled: z.boolean().optional(),
  archive_runtime: z.unknown().optional(),
  archive_policy: z.unknown().optional(),
});

/** Validate before release staging or stopping any service; never echo local configuration values. */
export function validateBotSettings(bot: string, text: string): void {
  try {
    const input: unknown = JSON.parse(text);
    if (bot === 'konata') {
      konataSettings.parse(input);
      return;
    }
    if (bot !== 'msg-archive') {
      settings.parse(input);
      return;
    }
    const config = archiveSettings.parse(input);
    parseArchiveSettings({
      backupServers: config.backup_server,
      ...(config.backup_interval_minutes === undefined
        ? {}
        : { backupIntervalMs: config.backup_interval_minutes * 60_000 }),
      policy: config.archive_policy,
      runtime: config.archive_runtime,
    });
  } catch (error) {
    const paths =
      error instanceof z.ZodError
        ? [...new Set(error.issues.map((issue) => issue.path.join('.') || 'root'))].join(', ')
        : 'JSON or archive settings';
    throw new Error(`Invalid config.json for ${bot}; check ${paths}`);
  }
}
