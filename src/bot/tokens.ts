/**
 * Standard service tokens — the composition root's binding catalog.
 *
 * Lives under `src/bot/` (not `src/core/ioc/`) because the catalog is
 * the one place that must name every concrete service type the bot
 * wires: a Mongo connection manager, the repository bundle, the LLM
 * model catalog. Declaring it inside `core/` would
 * force `core` to import from `infra/`, `persistence/`, and `plugins/`
 * — a dependency running the wrong way through the layer stack. The
 * container mechanism itself (`ServiceToken`, `token()`,
 * `ServiceContainer`) stays in `core/ioc`, which knows nothing about
 * what gets bound.
 *
 * Centralised so:
 *   - Token naming is reviewed in one place (no `MESSAGE_REPO_FACTORY`
 *     vs `MessageRepoFactory` drift across PRs).
 *   - The full catalog is visible to readers learning the container.
 *   - New service additions land here, not scattered across modules.
 *
 * Repository access is exposed as a **factory token** of shape
 * `(g: GuildId) => Promise<Repos>` rather than scoped registrations:
 * a factory token is one explicit line in the composition root, where
 * a per-request scope object would have to be threaded through the
 * whole call graph.
 *
 * Plugins import `TOKENS` from here directly (`../../bot/tokens`); the
 * ESLint `no-restricted-imports` rule for `src/plugins/**` keeps
 * `core/ioc` — the container's write side — out of reach so this stays
 * the single legal source.
 */
import type { Client } from 'discord.js';
import type { Job } from 'node-schedule';

import type { Env } from '../core/config';
import type { GuildId } from '../core/ids';
import type { Translator } from '../core/i18n';
import { token, type ServiceToken } from '../core/ioc';
import type { Logger } from '../core/logger';
import type { GuildOnboardingPort, PermissionRankPolicy } from '../core/plugin';
import type { Clock } from '../core/time';
import type { DefaultModelResolver } from '../infra/llm/default-model-resolver';
import type { ModelCatalog } from '../infra/llm/models-catalog';
import type { ConnectionManager } from '../infra/mongo/connection-manager';
import type { FeedPlatformRegistry } from '../infra/social-feed';
import type { Repos } from '../persistence/repositories';

import type { GuildRegistry } from './guild-registry';

/** Per-guild full-bundle factory — the repository entry point. */
export type ReposFactory = (guildId: GuildId) => Promise<Repos>;

interface Tokens {
  readonly ConnectionManager: ServiceToken<ConnectionManager>;
  readonly ReposFactory: ServiceToken<ReposFactory>;
  /**
   * Bot-scoped root logger. Resolved instance carries `{ bot: clientId }`
   * already bound; downstream code should `.child({ guildId })` /
   * `.child({ traceId })` for narrower scope.
   */
  readonly Logger: ServiceToken<Logger>;
  /** Bot-scoped Translator. The composition root registers the
   *  i18next-backed default; the plugin host receives it via
   *  PluginHostOptions. */
  readonly Translator: ServiceToken<Translator>;
  /** Wall-clock abstraction; tests substitute a FakeClock. */
  readonly Clock: ServiceToken<Clock>;
  /** Per-guild registry: repos / channel / role lookup by guild id. */
  readonly GuildRegistry: ServiceToken<GuildRegistry>;
  /**
   * Discord client. Plugins that need fetch / channel / message
   * primitives (notably the message-archive backup loop) resolve this
   * rather than reaching back to a BaseBot reference. Registered as
   * a singleton holding the live `Client` instance.
   */
  readonly DiscordClient: ServiceToken<Client>;
  /**
   * Validated, frozen environment. The `infra/llm` registry pulls
   * LLM provider API keys from this rather than reading
   * `process.env` directly, so the strict no-restricted-syntax rule
   * is honoured everywhere outside `core/config`.
   */
  readonly Env: ServiceToken<Env>;
  /**
   * Bot-scoped scheduled-job map. The activity + giveaway plugins
   * resolve this from `onReady` to drive their reboot loops without
   * holding a BaseBot reference.
   */
  readonly JobMap: ServiceToken<Map<string, Job>>;
  /**
   * Guild-onboarding port. The composition root binds the concrete
   * `BaseBot`-backed implementation; the `guild-events` plugin resolves
   * this to onboard new guilds from its `guildCreate` subscription
   * without reaching into `BaseBot` internals.
   */
  readonly GuildOnboardingPort: ServiceToken<GuildOnboardingPort>;
  /**
   * Operator-defined privacy / clearance ranking for channels and users
   * (`permission_rank` in `config.json`). Resolved by the guild-events /
   * social-link-preview plugins and the channel-logging middleware to decide
   * which channels each feature acts on. Built once from static config in the
   * `BaseBot` constructor; a bot that omits `permission_rank` gets an
   * all-rank-0 policy that suppresses nothing.
   */
  readonly PermissionRankPolicy: ServiceToken<PermissionRankPolicy>;
  /**
   * LLM model catalog, published by LlmChatPlugin's `init` hook via
   * {@link PluginInitContext.registerInstance}. Provides the live model
   * list used by `/ai_settings`. Unbound for bots that do not register
   * LlmChatPlugin.
   */
  readonly ModelCatalog: ServiceToken<ModelCatalog>;
  /**
   * Per-provider default-model resolver, published by LlmChatPlugin's
   * `init` hook. Keeps the whitelist-entry default pointed at the
   * cheapest still-listed model via a weekly refresh. Unbound for bots
   * that do not register LlmChatPlugin.
   */
  readonly DefaultModelResolver: ServiceToken<DefaultModelResolver>;
  /**
   * Feed platform Strategy lookup, built by each composition root from
   * its `social_feed.platforms` block. The `social-feed` plugin polls
   * through it and the `/feed_*` commands validate an account against
   * it. Unbound for bots that do not configure the feature.
   */
  readonly FeedPlatformRegistry: ServiceToken<FeedPlatformRegistry>;
}

export const TOKENS: Tokens = {
  ConnectionManager: token<ConnectionManager>('ConnectionManager'),
  ReposFactory: token<ReposFactory>('ReposFactory'),
  Logger: token<Logger>('Logger'),
  Translator: token<Translator>('Translator'),
  Clock: token<Clock>('Clock'),
  GuildRegistry: token<GuildRegistry>('GuildRegistry'),
  DiscordClient: token<Client>('DiscordClient'),
  Env: token<Env>('Env'),
  JobMap: token<Map<string, Job>>('JobMap'),
  GuildOnboardingPort: token<GuildOnboardingPort>('GuildOnboardingPort'),
  PermissionRankPolicy: token<PermissionRankPolicy>('PermissionRankPolicy'),
  ModelCatalog: token<ModelCatalog>('ModelCatalog'),
  DefaultModelResolver: token<DefaultModelResolver>('DefaultModelResolver'),
  FeedPlatformRegistry: token<FeedPlatformRegistry>('FeedPlatformRegistry'),
};
