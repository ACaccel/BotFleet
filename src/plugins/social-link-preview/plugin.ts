/**
 * `messageCreate` subscriber that detects social-media share links, posts a
 * better preview, and suppresses the user's original auto-preview. Provider
 * mechanics live in `src/infra/link-preview/`; adding a source needs no
 * change here.
 *
 * Per-bot settings are parsed once in the factory. The provider registry is
 * built only when the feature is enabled, because the embed-proxy host lists
 * it needs are operator configuration a disabled bot never supplies. Channel
 * suppression uses the {@link PermissionRankPolicy} resolved in `init` (the
 * `social_preview` feature, unbounded by default). `deps.registry` is a
 * test seam.
 *
 * The event handler swallows every error so a bad link cannot break the
 * channel.
 */
import { logError } from '../../core/logger';
import type { PermissionRankPolicy, Plugin } from '../../core/plugin';
import { TOKENS } from '../../bot/tokens';
import { ancestorChannelIdsOf } from '../../infra/discord';
import {
  createDefaultLinkPreviewRegistry,
  type LinkPreviewProviderRegistry,
} from '../../infra/link-preview';
import { parseSocialLinkPreviewConfig } from './config';
import { runSocialLinkPreview } from './internal/orchestrator';
import type { GuildSettingsRuntime } from '../../core/guild-settings';

const PLUGIN_ID = 'social-link-preview';
const PLUGIN_VERSION = '1.0.0';

/** Optional collaborators wired by the composition root / tests. */
interface CreateSocialLinkPreviewDeps {
  /** Provider registry; injectable so tests can supply fakes without the network. */
  readonly registry?: LinkPreviewProviderRegistry;
  readonly settings?: GuildSettingsRuntime;
}

export const createSocialLinkPreviewPlugin = (
  rawConfig: unknown,
  deps: CreateSocialLinkPreviewDeps = {},
): Plugin => {
  const config = parseSocialLinkPreviewConfig(rawConfig);
  const allowedBotIds = new Set(config.allowedBotIds);
  const registry =
    deps.registry ??
    (config.enabled
      ? createDefaultLinkPreviewRegistry({
          twitterProxyHosts: config.twitterProxyHosts,
          ...(config.twitterApiBaseUrls === undefined
            ? {}
            : { twitterApiBaseUrls: config.twitterApiBaseUrls }),
          instagramProxyHosts: config.instagramProxyHosts,
          threadsProxyHosts: config.threadsProxyHosts,
          facebookProxyHosts: config.facebookProxyHosts,
          redditProxyHosts: config.redditProxyHosts,
          bilibiliProxyHosts: config.bilibiliProxyHosts,
          enabledProviders: config.providers,
        })
      : undefined);

  let resolvedPolicy: PermissionRankPolicy | undefined;
  /**
   * See the `init` contract in `core/plugin/types.ts`: unreachable, and
   * raising matters doubly here — this policy is the channel-privacy
   * gate, and a gate that fails open is worse than one that fails loudly.
   */
  const policy = (): PermissionRankPolicy => {
    if (resolvedPolicy === undefined) {
      throw new TypeError('social-link-preview: event dispatched before init resolved the policy');
    }
    return resolvedPolicy;
  };

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async init(ctx): Promise<void> {
      resolvedPolicy = ctx.resolve(TOKENS.PermissionRankPolicy);
    },

    events: {
      messageCreate: async (ctx, message): Promise<void> => {
        // Disabled configs carry no proxy hosts and therefore no registry;
        // both halves are checked because nothing ties them together at
        // this point beyond how the factory built them.
        if (!config.enabled || registry === undefined) return;
        // Never preview our own output, even if this bot is accidentally allow-listed.
        if (message.author.id === message.client.user.id) return;
        if (message.author.bot && !allowedBotIds.has(message.author.id)) return;
        if (message.guildId === null) return; // guild-only
        const ancestors = ancestorChannelIdsOf(message.channel, message.guild?.channels.cache);
        const snapshot = deps.settings?.get(message.guildId);
        if (
          deps.settings !== undefined &&
          (snapshot === undefined ||
            !deps.settings.isEnabled(
              message.guildId,
              'social_preview',
              message.channelId,
              ancestors,
            ))
        )
          return;
        const preferences = snapshot?.settings.socialPreview;
        // Channels above the social_preview rank ceiling are suppressed.
        // Default ceiling is unbounded, so this is a no-op unless an operator
        // sets a finite `social_preview.maxChannelRank`.
        if (
          policy().isSuppressed(message.guildId, 'social_preview', message.channelId, ancestors)
        ) {
          return;
        }
        if (!message.channel.isSendable()) return;

        try {
          await runSocialLinkPreview(
            {
              registry,
              config:
                preferences === undefined
                  ? config
                  : {
                      ...config,
                      originalMessageStrategy: preferences.originalMessageStrategy,
                      maxUrlsPerMessage: Math.min(
                        config.maxUrlsPerMessage,
                        preferences.maxUrlsPerMessage,
                      ),
                    },
              ...(preferences === undefined
                ? {}
                : {
                    providers: new Set(
                      preferences.providers.filter(
                        (name) =>
                          config.providers === undefined ||
                          config.providers.some((allowed) => allowed === name),
                      ),
                    ),
                    videoEnabled: preferences.videoEnabled,
                  }),
              translator: ctx.translator,
              logger: ctx.logger,
            },
            message,
          );
        } catch (err: unknown) {
          // Inner code already swallows per-URL failures; this is the
          // belt-and-suspenders guard for anything unexpected.
          logError(ctx.logger, message.guildId, err);
        }
      },
    },
  };
};
