import type { Client } from 'discord.js';
import type { Config } from '@bot';
import { BaseBot } from '@bot';
import {
  createAutoReplyPlugin,
  createActivityPlugin,
  createBugReportPlugin,
  createDbInspectPlugin,
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
  /** Raw `bug_report` block; validated by `/bug_report` and its plugin. */
  bug_report?: unknown;
}

export class Nijika extends BaseBot<NijikaConfig> {
  /**
   * @param webhookPort - TCP port for the earthquake-alert webhook
   *   server. Sourced from the validated `Env.PORT` in `index.ts`;
   *   passed through the constructor (rather than read from
   *   `process.env` here) so the composition root stays the single
   *   place that touches the environment.
   * @param cwaApiKey - Central Weather Administration open-data key
   *   (`Env.CWA_API_KEY`), threaded the same way. When absent the
   *   earthquake plugin skips report polling and keeps only the webhook.
   * @param mongoInspectUri - Read-only account for `/db`
   *   (`Env.MONGO_INSPECT_URI`); required when `config.commands` lists `db`.
   */
  public constructor(
    client: Client,
    token: string,
    mongoURI: string,
    clientId: string,
    config: NijikaConfig,
    webhookPort: number,
    cwaApiKey: string | undefined,
    mongoInspectUri: string | undefined,
  ) {
    super(client, token, mongoURI, clientId, config);
    // `helpMessage` is resolved from this key inside BaseBot.run()
    // once the translator is loaded.
    this.helpMessageKey = 'replies:nijika.help_message';
    this.personaSection = 'replies:nijika';

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
    // `/bug_report` tickets: relay between the hub forum and reporters' DMs.
    this.use(
      createBugReportPlugin({
        config: this.config.bug_report,
        isAdmin: (userId) => this.isAdmin(userId),
        label: () => this.personaName || (this.client.user?.username ?? this.clientId),
      }),
    );
    // Feed platforms are built once from config and shared: the poller
    // reads timelines through the registry and the `/feed` commands
    // validate an account against the same instances.
    const feedPlatforms = createDefaultFeedPlatformRegistry(
      parseFeedPlatformsConfig(this.config.social_feed),
    );
    this.container.registerSingleton(TOKENS.FeedPlatformRegistry, () => feedPlatforms);
    // Polls each guild's stored feed subscriptions and forwards the new
    // posts that match every subscription's own filter.
    this.use(createSocialFeedPlugin(this.config.social_feed, { platforms: feedPlatforms }));
    // Earthquake early-warning webhook (its `start` hook owns the Express
    // route) plus the CWA report poller, which runs only with a key.
    this.use(createEarthquakePlugin({ port: webhookPort, cwaApiKey }));
    if ((this.config.commands ?? []).includes('db')) {
      if (mongoInspectUri === undefined) {
        throw new Error('config.commands lists db, which requires MONGO_INSPECT_URI');
      }
      // Read-only `/db` inspection on its own verified read-only account.
      this.use(createDbInspectPlugin({ uri: mongoInspectUri }));
    }
  }

  protected override supportsDbInspect(): boolean {
    return true;
  }
}
