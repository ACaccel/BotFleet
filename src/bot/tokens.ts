/**
 * Standard service tokens — the composition root's binding catalog. It
 * names every concrete service type the bot wires, so it lives in `bot/`
 * rather than `core/ioc`, which provides only the container mechanism.
 *
 * Repository access is a factory token, `(g: GuildId) => Promise<Repos>`,
 * rather than a scoped registration: one explicit line in the composition
 * root instead of a scope object threaded through the whole call graph.
 *
 * Plugins import `TOKENS` from here; ESLint keeps `core/ioc` (the
 * container's write side) out of their reach.
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
import type { ArchiveControlFactory } from '../application/archive/control';
import type { DbInspectService } from '../application/db-inspect/service';
import type { GuildSettingsService } from '../application/guild-settings/service';
import type { DefaultModelResolver } from '../infra/llm/default-model-resolver';
import type { ModelCatalog } from '../infra/llm/models-catalog';
import type { ConnectionManager } from '../infra/mongo/connection-manager';
import type { FeedPlatformRegistry } from '../infra/social-feed';
import type { Repos } from '../persistence/repositories';

import type { GuildRegistry } from './guild-registry';

/** Per-guild full-bundle factory — the repository entry point. */
export type ReposFactory = (guildId: GuildId) => Promise<Repos>;

interface Tokens {
  readonly GuildSettings: ServiceToken<GuildSettingsService>;
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
   * list used by `/ai settings`. Unbound for bots that do not register
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
  /**
   * Builds one guild's archive control service. Registered only by the
   * msg-archive composition root, which holds archive ownership; the
   * `/archive` command and panel buttons read it through
   * `BaseBot.archiveControlFactory`, and tests substitute a fake.
   */
  readonly ArchiveControlFactory: ServiceToken<ArchiveControlFactory>;
  /**
   * Read-only database inspection behind `/db`. Published by the
   * db-inspect plugin, which only nijika registers; the command reads it
   * through `BaseBot.dbInspectService`.
   */
  readonly DbInspectService: ServiceToken<DbInspectService>;
}

export const TOKENS: Tokens = {
  GuildSettings: token<GuildSettingsService>('GuildSettings'),
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
  ArchiveControlFactory: token<ArchiveControlFactory>('ArchiveControlFactory'),
  DbInspectService: token<DbInspectService>('DbInspectService'),
};
