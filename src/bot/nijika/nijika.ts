import type { Client } from 'discord.js';
import type { Config } from '@bot';
import { BaseBot } from '@bot';
import {
  createAutoReplyPlugin,
  createActivityPlugin,
  createEarthquakePlugin,
  createGiveawayPlugin,
  createGuildEventsPlugin,
  createSocialFeedPlugin,
  createSocialLinkPreviewPlugin,
  createTempRolePlugin,
} from '@plugins';

import {
  createDefaultFeedPlatformRegistry,
  parseFeedPlatformsConfig,
} from '../../infra/social-feed';
import { TOKENS } from '../tokens';

/**
 * Config key retired by the social-feed rename.
 *
 * Subscriptions moved out of config and into each guild's database, so
 * a config still carrying this block describes a feed that no longer
 * exists. Nothing validates the top level of a bot's `config.json`, so
 * the plugin's own `.strict()` schema never sees the stale key and the
 * feed would simply go dark; rejecting it here is what makes the
 * migration loud instead of silent.
 */
const RETIRED_FEED_CONFIG_KEY = 'x_media_feed';

interface NijikaConfig extends Config {
  level_roles: Record<string, string>;
  /**
   * Raw `auto_reply` block. Parsed and defaulted by the plugin
   * (see `createAutoReplyPlugin`), so it is intentionally `unknown`
   * here and may be omitted entirely.
   */
  auto_reply?: unknown;
  /**
   * Raw `social_link_preview` block. Parsed and defaulted by the plugin
   * (see `createSocialLinkPreviewPlugin`), so it is intentionally
   * `unknown` here and may be omitted entirely.
   */
  social_link_preview?: unknown;
  /**
   * Raw `social_feed` block. Parsed and defaulted by the plugin
   * (see `createSocialFeedPlugin`), so it is intentionally `unknown`
   * here and may be omitted entirely. Its `platforms` sub-block is also
   * read here to build the shared platform registry.
   */
  social_feed?: unknown;
  /**
   * Raw `guild_events` block. Parsed and defaulted by the plugin
   * (see `createGuildEventsPlugin`), so it is intentionally `unknown`
   * here and may be omitted entirely.
   */
  guild_events?: unknown;
}

export class Nijika extends BaseBot<NijikaConfig> {
  /**
   * @param webhookPort - TCP port for the earthquake-alert webhook
   *   server. Sourced from the validated `Env.PORT` in `index.ts`;
   *   passed through the constructor (rather than read from
   *   `process.env` here) so the composition root stays the single
   *   place that touches the environment.
   */
  public constructor(
    client: Client,
    token: string,
    mongoURI: string,
    clientId: string,
    config: NijikaConfig,
    webhookPort: number,
  ) {
    super(client, token, mongoURI, clientId, config);
    // `helpMessage` is resolved from this key inside BaseBot.run()
    // once the translator is loaded.
    this.helpMessageKey = 'replies:nijika.help_message';

    // Plugin registration. Channel suppression (which channels each
    // feature acts on) is resolved from the per-guild `permission_rank`
    // config via `TOKENS.PermissionRankPolicy`; the composition root no
    // longer threads a channel list in. Plugins resolve their
    // dependencies through `ctx`, so the composition root does not
    // deep-import `plugins/*/internal`.
    this.use(createAutoReplyPlugin(this.config.auto_reply));
    this.use(createGuildEventsPlugin(this.config.guild_events));
    // Social-link preview: detect share links, post a richer preview,
    // and suppress the user's original auto-embed.
    this.use(createSocialLinkPreviewPlugin(this.config.social_link_preview));
    this.use(createGiveawayPlugin());
    this.use(createActivityPlugin());
    // Temporary, permission-less notification roles with a self-claim
    // button and a hard 30-day expiry (see `createTempRolePlugin`).
    this.use(createTempRolePlugin());
    if (RETIRED_FEED_CONFIG_KEY in config) {
      throw new Error(
        `nijika config.json still declares "${RETIRED_FEED_CONFIG_KEY}"; it is now "social_feed", ` +
          'and the accounts it listed must be re-added per channel with /feed_subscribe',
      );
    }
    // Feed platforms are built once from config and shared: the poller
    // reads timelines through the registry and the `/feed_*` commands
    // validate an account against the same instances.
    const feedPlatforms = createDefaultFeedPlatformRegistry(
      parseFeedPlatformsConfig(this.config.social_feed),
    );
    this.container.registerSingleton(TOKENS.FeedPlatformRegistry, () => feedPlatforms);
    // Polls each guild's stored feed subscriptions and forwards the new
    // posts that match every subscription's own filter.
    this.use(createSocialFeedPlugin(this.config.social_feed, { platforms: feedPlatforms }));
    // The earthquake webhook server + per-guild broadcast is a
    // bot-scoped plugin; its `start` hook owns the Express route.
    this.use(createEarthquakePlugin({ port: webhookPort }));
  }
}
