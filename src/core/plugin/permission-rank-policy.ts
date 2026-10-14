/**
 * Operator-defined privacy / clearance ranking for channels and users,
 * resolved once from `config.json` at composition time.
 *
 * ORTHOGONAL to Discord's permission system: a numeric ranking the operator
 * declares, consumed by features to decide what to surface where. A CHANNEL
 * carries a privacy rank (higher = more private); a USER carries a clearance
 * rank from their ranked roles (higher = sees more).
 *
 * A feature suppresses output in a channel whose effective rank exceeds the
 * feature's ceiling ({@link PermissionRankPolicy.isSuppressed}).
 * Clearance-based consumers compose
 * {@link PermissionRankPolicy.channelRank},
 * {@link PermissionRankPolicy.userRank}, and
 * {@link PermissionRankPolicy.visibilityCeiling} directly.
 *
 * Discord ids are plain strings; the policy never resolves them against the
 * live client.
 */
import { z } from 'zod';

/**
 * A non-negative integer rank. Branded (mirrors `src/core/ids.ts`) so a raw
 * count or threshold cannot be passed where a rank is expected, and so the
 * `>=` / `min` / `max` comparisons that gate privacy carry nominal intent.
 */
export type Rank = number & { readonly __brand: 'Rank' };

/**
 * Brand an untrusted number as a {@link Rank}. Throws a native `TypeError`
 * (a contract violation, not a recoverable `DomainError`) on a non-integer or
 * negative value, mirroring the `as*` id constructors in `core/ids`.
 */
const asRank = (value: number): Rank => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`Expected a non-negative integer rank, received ${String(value)}`);
  }
  return value as Rank;
};

/**
 * The shared rank floor. An unlisted channel and a member with no ranked role
 * both resolve here. The two floors INTENTIONALLY coincide at 0; if a future
 * requirement needs them to diverge, change them here, in one place.
 */
const RANK_ZERO: Rank = asRank(0);

/**
 * Brand-preserving max / min. `Math.max` / `Math.min` widen a branded
 * {@link Rank} back to `number`, so privacy comparisons use these instead.
 * Internal: consumers compose ranks through {@link PermissionRankPolicy}
 * (`visibilityCeiling`) rather than reaching for these directly.
 */
const maxRank = (a: Rank, b: Rank): Rank => (a >= b ? a : b);
const minRank = (a: Rank, b: Rank): Rank => (a <= b ? a : b);

/**
 * Per-feature default channel-rank ceilings.
 *
 * Kept as RAW `number | null` literals (not branded {@link Rank}) so the `as
 * const satisfies` assertion compiles — a branded literal cannot appear in a
 * const assertion, and `asRank()` cannot be called inside one. Ranks are
 * branded at the policy boundary instead ({@link toCeiling}).
 *
 * {@link RankedFeature} is DERIVED from these keys (`keyof typeof`), so adding
 * a feature here without a default is impossible, and forgetting to extend the
 * parser is caught by the lockstep assertion below.
 *
 * Defaults express the confirmed behaviour:
 *   - `guild_events` discloses to the Discord `event` channel only for rank-0
 *     (public) channels. This ceiling gates DISCLOSURE, not recording: the
 *     guild-events plugin still records every edit/delete to the local
 *     structured log and archives deleted attachments regardless of rank.
 *   - `channel_logging` acts only on rank-0 (public) channels;
 *   - `social_preview` has no ceiling (`null`) — it acts on every channel.
 */
const RAW_DEFAULT_CEILINGS = {
  guild_events: 0,
  channel_logging: 0,
  social_preview: null,
} as const satisfies Record<string, number | null>;

/** The features that consult the channel-rank ceiling. */
export type RankedFeature = keyof typeof RAW_DEFAULT_CEILINGS;

/** Every rank-gated feature, derived from the default-ceiling table. */
export const RANKED_FEATURES = Object.keys(RAW_DEFAULT_CEILINGS) as readonly RankedFeature[];

/**
 * A feature's channel-rank ceiling: the highest channel rank it still acts on.
 * `null` ({@link UNBOUNDED}) means "no ceiling" — the feature always acts.
 */
const UNBOUNDED = null;
type Ceiling = Rank | typeof UNBOUNDED;

const toCeiling = (raw: number | null): Ceiling => (raw === null ? UNBOUNDED : asRank(raw));

/**
 * Code defaults, branded once. A guild with no `features` override uses these.
 * `satisfies` (not an `as` cast) so adding a feature to {@link
 * RAW_DEFAULT_CEILINGS} without a default here is a compile error.
 */
const DEFAULT_CEILINGS = {
  guild_events: toCeiling(RAW_DEFAULT_CEILINGS.guild_events),
  channel_logging: toCeiling(RAW_DEFAULT_CEILINGS.channel_logging),
  social_preview: toCeiling(RAW_DEFAULT_CEILINGS.social_preview),
} satisfies Record<RankedFeature, Ceiling>;

// ---- config schema (fail-fast, operator-facing) ----

const rankSchema = z.number().int().min(0);
const featureCeilingSchema = z.object({ maxChannelRank: rankSchema.nullable() }).strict();

/**
 * Per-guild `permission_rank` block. `.strict()` rejects an unknown key
 * (including a feature not yet in {@link RankedFeature}, e.g. `llm_auto_reply`)
 * so a typo or an out-of-scope feature fails fast at startup rather than
 * silently disabling privacy. A `null` `maxChannelRank` means "unbounded";
 * a missing feature key falls back to the code default.
 */
const permissionRankConfigSchema = z
  .object({
    channels: z.record(z.string(), rankSchema).default({}),
    roles: z.record(z.string(), rankSchema).default({}),
    features: z
      .object({
        guild_events: featureCeilingSchema.optional(),
        channel_logging: featureCeilingSchema.optional(),
        social_preview: featureCeilingSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

/** Raw (pre-default) shape an operator writes under `guilds.<id>.permission_rank`. */
export type PermissionRankConfig = z.input<typeof permissionRankConfigSchema>;

// `RankedFeature` is derived from RAW_DEFAULT_CEILINGS; two mechanisms keep the
// zod `features` parser in lockstep with it. (1) `toParsedGuildRanks` indexes
// `parsed.features[feature]` over `RANKED_FEATURES`, so adding a feature to
// RAW_DEFAULT_CEILINGS without a matching schema key fails to compile. (2) The
// "accepts every RankedFeature as a config override" test in
// `permission-rank-policy.test.ts` asserts the reverse (a schema key dropped
// relative to RAW_DEFAULT_CEILINGS) fails fast at runtime via `.strict()`.

/**
 * Read-only privacy / clearance ranking, resolved from static config and
 * resolved by consumers via `TOKENS.PermissionRankPolicy`. Built once at
 * composition time; never mutated, never reads the live Discord client.
 */
export interface PermissionRankPolicy {
  /**
   * Effective privacy rank of a channel = `max(own rank, ranks of its
   * ancestors)`. An unlisted channel (or an unknown guild) is {@link
   * RANK_ZERO}. Pass `ancestorChannelIds` — the channel's parent chain
   * (parent channel, then category) — so a private category / forum raises the
   * effective rank of everything nested under it; effective rank is monotonic,
   * an ancestor can only raise it, never lower it. The policy cannot verify
   * topology without the Discord client, so it trusts the ids to be genuine
   * ancestors: `ancestorChannelIdsOf` (`infra/discord`) is the single safe
   * extraction every consumer uses to derive them.
   */
  channelRank(guildId: string, channelId: string, ancestorChannelIds?: readonly string[]): Rank;
  /**
   * Clearance rank of a member = the max rank over their ranked roles, or
   * {@link RANK_ZERO} when none match. `roleIds` is the member's role ids
   * (e.g. `member.roles.cache.keys()`); kept primitive so the policy stays
   * discord.js-free. An empty / partial iterable yields {@link RANK_ZERO}.
   */
  userRank(guildId: string, roleIds: Iterable<string>): Rank;
  /**
   * Whether `feature` must suppress its output for `channelId`:
   * `effectiveChannelRank > ceiling(feature)`. An unbounded (`null`) ceiling
   * never suppresses. The ceilings and their code defaults are private to the
   * policy — a feature passes only its key.
   *
   * "Output" is the feature's externally-visible effect, which is
   * feature-specific: for `guild_events` it is the Discord `event`-channel
   * mirror, NOT the always-on local audit log / attachment archival. A feature
   * decides for itself which side effects this gate covers.
   */
  isSuppressed(
    guildId: string,
    feature: RankedFeature,
    channelId: string,
    ancestorChannelIds?: readonly string[],
  ): boolean;
  /**
   * The highest channel rank a member may see from a given command channel:
   * `min(userRank, channelRank(commandChannel))`. The `/traffic` commands show
   * channel `T` iff `channelRank(T) <= visibilityCeiling(...)`. Pass
   * `commandAncestorChannelIds` so the command channel's own rank reflects its
   * full ancestry (a command run in a thread inherits its category's rank).
   */
  visibilityCeiling(
    guildId: string,
    roleIds: Iterable<string>,
    commandChannelId: string,
    commandAncestorChannelIds?: readonly string[],
  ): Rank;
}

interface ParsedGuildRanks {
  readonly channels: ReadonlyMap<string, Rank>;
  readonly roles: ReadonlyMap<string, Rank>;
  readonly ceilings: Readonly<Record<RankedFeature, Ceiling>>;
}

/**
 * The single production implementation. Private to the module: consumers
 * depend on {@link PermissionRankPolicy} (the interface) so tests inject an
 * in-memory fake the same way they fake repos / the clock.
 */
class StaticPermissionRankPolicy implements PermissionRankPolicy {
  readonly #byGuild: ReadonlyMap<string, ParsedGuildRanks>;

  public constructor(byGuild: ReadonlyMap<string, ParsedGuildRanks>) {
    this.#byGuild = byGuild;
  }

  public channelRank(
    guildId: string,
    channelId: string,
    ancestorChannelIds?: readonly string[],
  ): Rank {
    const guild = this.#byGuild.get(guildId);
    if (guild === undefined) return RANK_ZERO;
    let rank = guild.channels.get(channelId) ?? RANK_ZERO;
    if (ancestorChannelIds !== undefined) {
      for (const ancestorId of ancestorChannelIds) {
        const ancestorRank = guild.channels.get(ancestorId);
        if (ancestorRank !== undefined) rank = maxRank(rank, ancestorRank);
      }
    }
    return rank;
  }

  public userRank(guildId: string, roleIds: Iterable<string>): Rank {
    const guild = this.#byGuild.get(guildId);
    if (guild === undefined) return RANK_ZERO;
    let highest: Rank = RANK_ZERO;
    for (const roleId of roleIds) {
      const rank = guild.roles.get(roleId);
      if (rank !== undefined && rank > highest) highest = rank;
    }
    return highest;
  }

  public isSuppressed(
    guildId: string,
    feature: RankedFeature,
    channelId: string,
    ancestorChannelIds?: readonly string[],
  ): boolean {
    const ceiling = (this.#byGuild.get(guildId)?.ceilings ?? DEFAULT_CEILINGS)[feature];
    if (ceiling === UNBOUNDED) return false;
    return this.channelRank(guildId, channelId, ancestorChannelIds) > ceiling;
  }

  public visibilityCeiling(
    guildId: string,
    roleIds: Iterable<string>,
    commandChannelId: string,
    commandAncestorChannelIds?: readonly string[],
  ): Rank {
    return minRank(
      this.userRank(guildId, roleIds),
      this.channelRank(guildId, commandChannelId, commandAncestorChannelIds),
    );
  }
}

const toParsedGuildRanks = (
  parsed: z.infer<typeof permissionRankConfigSchema>,
): ParsedGuildRanks => {
  const channels = new Map<string, Rank>();
  for (const [channelId, rank] of Object.entries(parsed.channels)) {
    channels.set(channelId, asRank(rank));
  }
  const roles = new Map<string, Rank>();
  for (const [roleId, rank] of Object.entries(parsed.roles)) {
    roles.set(roleId, asRank(rank));
  }
  const ceilings: Record<RankedFeature, Ceiling> = { ...DEFAULT_CEILINGS };
  for (const feature of RANKED_FEATURES) {
    const override = parsed.features[feature];
    if (override !== undefined) ceilings[feature] = toCeiling(override.maxChannelRank);
  }
  return { channels, roles, ceilings };
};

/**
 * Build the policy from each guild's raw `permission_rank` block (the value of
 * `guilds.<id>.permission_rank`, or `undefined` when omitted). Validates
 * fail-fast: a malformed block throws at construction (startup) with the
 * offending guild id and the zod issues, so a bad static config never degrades
 * silently to "nothing is private".
 *
 * Operator-facing by design: the thrown message is an English ops-log line,
 * not a user-facing translated string — these features emit nothing to users,
 * so no `errors.json` catalog key is involved.
 */
export const createPermissionRankPolicy = (
  rawByGuild: Readonly<Record<string, unknown>>,
): PermissionRankPolicy => {
  const byGuild = new Map<string, ParsedGuildRanks>();
  for (const [guildId, raw] of Object.entries(rawByGuild)) {
    if (raw === undefined) continue;
    const result = permissionRankConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid permission_rank config for guild ${guildId}: ${issues}`, {
        cause: result.error,
      });
    }
    byGuild.set(guildId, toParsedGuildRanks(result.data));
  }
  return new StaticPermissionRankPolicy(byGuild);
};
