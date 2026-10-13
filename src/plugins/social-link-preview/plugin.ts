/**
 * SocialLinkPreviewPlugin — a `messageCreate` subscriber that detects
 * social-media share links (Twitter/X, Instagram, Threads, Facebook,
 * Bahamut), posts a better preview, and suppresses the user's original
 * auto-preview.
 *
 * Hybrid mechanism (see `src/infra/link-preview/`): video-capable
 * sources are rewritten to an embed-proxy domain so Discord unfurls a
 * playable video; Facebook retains metadata for custom cards and bounded
 * video attachments; X posts read from a JSON API become custom cards,
 * keeping the proxy for videos it can play. Sources without a proxy
 * (Bahamut) use static cards. The provider framework is extensible —
 * adding a source is one provider file plus one registry line, with no
 * change here.
 *
 * Factory pattern (mirrors `createLlmAutoReplyPlugin`): per-bot settings
 * are parsed once and the provider registry is captured in the closure,
 * so the returned object is pure data. The registry exists only when the
 * feature is enabled, because the embed-proxy host lists it is built from
 * are operator configuration that a disabled bot never supplies. Channel
 * suppression is decided per event by the {@link PermissionRankPolicy}
 * resolved once in `init` (the `social_preview`
 * feature; its default ceiling is unbounded, so previews fire everywhere
 * unless an operator sets a finite ceiling). `deps` exposes an injectable
 * `registry` seam for deterministic tests.
 *
 * The event handler swallows every error so a bad link cannot break
 * the channel.
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

const PLUGIN_ID = 'social-link-preview';
const PLUGIN_VERSION = '1.0.0';

/** Optional collaborators wired by the composition root / tests. */
interface CreateSocialLinkPreviewDeps {
  /** Provider registry; injectable so tests can supply fakes without the network. */
  readonly registry?: LinkPreviewProviderRegistry;
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
        // Channels above the social_preview rank ceiling are suppressed.
        // Default ceiling is unbounded, so this is a no-op unless an operator
        // sets a finite `social_preview.maxChannelRank`.
        if (
          policy().isSuppressed(
            message.guildId,
            'social_preview',
            message.channelId,
            ancestorChannelIdsOf(message.channel, message.guild?.channels.cache),
          )
        ) {
          return;
        }
        if (!message.channel.isSendable()) return;

        try {
          await runSocialLinkPreview(
            { registry, config, translator: ctx.translator, logger: ctx.logger },
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
