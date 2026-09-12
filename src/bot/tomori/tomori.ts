import type { Client } from 'discord.js';
import { ActivityType, Events } from 'discord.js';

import type { Config } from '@bot';
import { BaseBot } from '@bot';
import {
  createAutoReplyPlugin,
  createActivityPlugin,
  createGiveawayPlugin,
  createGuildEventsPlugin,
  createSocialLinkPreviewPlugin,
  createTempRolePlugin,
} from '@plugins';

// Tomori is the public-facing personality: nijika's interactive feature
// set minus the self-guild-only surfaces (earthquake webhook, level-role
// sync). It adds no fields beyond the base `Config` except the optional
// `social_link_preview` and `auto_reply` blocks, which the owning
// plugins parse and default in code. Channel suppression for guild-events / social-link-preview /
// channel-logging comes from the per-guild `permission_rank` block (see
// `GuildConfig.permission_rank`), resolved via `TOKENS.PermissionRankPolicy`,
// rather than a personality-level list.
interface TomoriConfig extends Config {
  /**
   * Raw `social_link_preview` block. Parsed and defaulted by the plugin
   * (see `createSocialLinkPreviewPlugin`), so it is intentionally
   * `unknown` here and may be omitted entirely.
   */
  social_link_preview?: unknown;
  /**
   * Raw `auto_reply` block. Parsed and defaulted by the plugin
   * (see `createAutoReplyPlugin`), so it is intentionally `unknown`
   * here and may be omitted entirely.
   */
  auto_reply?: unknown;
  /**
   * Raw `guild_events` block. Parsed and defaulted by the plugin
   * (see `createGuildEventsPlugin`), so it is intentionally `unknown`
   * here and may be omitted entirely.
   */
  guild_events?: unknown;
}

export class Tomori extends BaseBot<TomoriConfig> {
  public constructor(
    client: Client,
    token: string,
    mongoURI: string,
    clientId: string,
    config: TomoriConfig,
  ) {
    super(client, token, mongoURI, clientId, config);
    // Intro paragraph rendered at the top of the `/help` embed; the
    // key is resolved once the translator is loaded (see BaseBot.run).
    this.helpMessageKey = 'replies:tomori.help_message';
    // Tomori opts into auto-reply, guild-event mirroring, social-link
    // preview, giveaway, activity and temporary-role behaviour
    // by registering the corresponding plugins explicitly. Plugins
    // resolve their dependencies through `ctx`, so the composition root
    // does not deep-import `plugins/*/internal`.
    //
    // `guild-events` is what subscribes to `messageUpdate` /
    // `messageDelete` / `guildMemberUpdate` / `guildCreate`; without
    // it the ClientEventBridge never wires those Discord events and
    // no audit log / channel mirror is produced.
    this.use(createAutoReplyPlugin(this.config.auto_reply));
    this.use(createGuildEventsPlugin(this.config.guild_events));
    // Social-link preview: detect share links, post a richer preview,
    // and suppress the user's original auto-embed (mirrors nijika).
    this.use(createSocialLinkPreviewPlugin(this.config.social_link_preview));
    this.use(createGiveawayPlugin());
    this.use(createActivityPlugin());
    // Temporary, permission-less notification roles with a self-claim
    // button and a hard 30-day expiry (see `createTempRolePlugin`).
    this.use(createTempRolePlugin());
    this.registerPresence();
  }

  /**
   * Without an explicit presence, Discord clients tend to render an idle
   * bot as offline even though its gateway session is still alive.
   * Register a ready-time presence so tomori reliably appears online
   * with a custom status line.
   */
  private registerPresence(): void {
    this.client.once(Events.ClientReady, () => {
      const text = this.translator?.t('replies:tomori.presence_text') ?? '';
      if (text.length === 0) return;
      this.client.user?.setPresence({
        status: 'online',
        activities: [
          {
            name: text,
            type: ActivityType.Custom,
            state: text,
          },
        ],
      });
    });
  }
}
