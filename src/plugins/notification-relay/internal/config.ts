/**
 * The `notificationRoutes` block of a bot's `config.json`: named
 * destinations a local caller may post notifications to. Callers name a
 * route, never a channel, so the API cannot be pointed anywhere else.
 */
import { z } from 'zod';

/** Route names as they appear in the URL path. */
export const ROUTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');

const RouteSchema = z.object({ guildId: snowflake, channelId: snowflake }).strict();

/** Exported for the deployment preflight, which checks the block before cutover. */
export const NotificationRoutesSchema = z.record(
  z.string().regex(ROUTE_NAME_PATTERN, 'route names use lowercase letters, digits and hyphens'),
  RouteSchema,
);

export interface NotificationRoute {
  readonly guildId: string;
  readonly channelId: string;
}

/** Parse the block; absent means no routes. Throws when it is malformed. */
export const parseNotificationRoutes = (raw: unknown): ReadonlyMap<string, NotificationRoute> =>
  new Map(Object.entries(NotificationRoutesSchema.optional().parse(raw) ?? {}));
