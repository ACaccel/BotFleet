/**
 * AutoReplyPlugin — Discord `messageCreate` subscriber that drives the
 * auto-reply behaviour as a self-contained plugin.
 *
 * Behaviours:
 *   - Hard-coded reaction to the "肥貓晚安" line (fires even for bots).
 *   - DB-backed reply lookup via `ReplyRepo.findByInput`; random pick
 *     when multiple replies match the same input.
 *   - Per-user lucky replies from the operator's `auto_reply` config
 *     block (see `./config.ts`), and a global lucky "[*]" reply at the
 *     configured probability.
 *   - `長髮男` regex reply.
 *   - `<count>d<sides>` dice expression with 0 < count < 100 and
 *     0 < sides < 2^30 bounds.
 *
 * The operator config is parsed once and captured in the factory closure
 * (mirrors `createSocialLinkPreviewPlugin`); {@link GuildRegistry} is
 * resolved once in `init`, so a message event costs no container lookup.
 */
import { areAutoRepliesSuppressed } from '../../infra/discord/suppressed-auto-replies';
import { TOKENS } from '../../bot/tokens';
import type { GuildRegistry } from '../../bot/guild-registry';
import type { Logger } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import { requireCapture } from '../../core/regex-capture';
import { parseAutoReplyConfig } from './config';
import type { GuildSettingsRuntime } from '../../core/guild-settings';
import { ancestorChannelIdsOf } from '../../infra/discord';
import { ReplyCooldown } from './cooldown';

const PLUGIN_ID = 'auto-reply';
const PLUGIN_VERSION = '1.0.0';

// i18n-ignore: trigger-matching keyword/regex, not user-facing prose.
const LONG_HAIR_REGEX = /長髮男(?=\s|$)/;
const DICE_REGEX = /^(\d+)d(\d+)$/;
const DICE_MAX_COUNT = 100;
const DICE_MAX_SIDES = 2 ** 30;

// i18n-ignore: trigger-matching keyword, not a user-facing reply.
const GOODNIGHT_LINE = '該睡覺了，肥貓跟你說晚安';

/** Roll dice; `null` when the input is not a dice expression. */
export const rollDice = (msg: string): string | null => {
  const match = DICE_REGEX.exec(msg);
  if (match === null) return null;
  const count = Number.parseInt(requireCapture(match, 1), 10);
  const sides = Number.parseInt(requireCapture(match, 2), 10);
  if (count <= 0 || count > DICE_MAX_COUNT || sides <= 0 || sides > DICE_MAX_SIDES) {
    return `out of range (0 < count < ${DICE_MAX_COUNT}, 0 < sides < 2^30)`;
  }
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  return `🎲 ${count}d${sides}: [${rolls.join(', ')}]`;
};

/**
 * Look up a reply for `input` from the per-guild ReplyRepo. Returns a
 * matching reply (uniformly random when multiple match), or `null`
 * when nothing matches. Repo failures propagate; the caller is
 * expected to catch and log.
 */
const lookupReply = async (
  registry: GuildRegistry,
  guildId: string,
  input: string,
): Promise<string | null> => {
  const repos = registry.getRepos(guildId);
  if (repos === undefined) return null;
  // findByInput returns Result<readonly ReplyDoc[], DatabaseError>.
  // An `err` is re-thrown so `safeLookup` catches it, logs through the
  // structured logger, and continues with the static behaviours.
  const result = await repos.reply.findByInput(input);
  if (!result.ok) throw result.error;
  const results = result.value;
  if (results.length === 0) return null;
  const pick = results[Math.floor(Math.random() * results.length)];
  return pick?.reply ?? null;
};

const safeLookup = async (
  registry: GuildRegistry,
  guildId: string,
  input: string,
  logger: Logger,
  context: string,
): Promise<string | null> => {
  try {
    return await lookupReply(registry, guildId, input);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err : new Error(String(err)), guildId, context },
      'auto-reply: reply lookup threw; continuing with static behaviours',
    );
    return null;
  }
};

export const createAutoReplyPlugin = (
  rawConfig?: unknown,
  settings?: GuildSettingsRuntime,
): Plugin => {
  const config = parseAutoReplyConfig(rawConfig);
  const cooldown = new ReplyCooldown();
  let resolvedRegistry: GuildRegistry | undefined;
  /** See the `init` contract in `core/plugin/types.ts`: unreachable. */
  const registryOf = (): GuildRegistry => {
    if (resolvedRegistry === undefined) {
      throw new TypeError('auto-reply: event dispatched before init resolved the registry');
    }
    return resolvedRegistry;
  };

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async init(ctx): Promise<void> {
      resolvedRegistry = ctx.resolve(TOKENS.GuildRegistry);
    },

    async onShutdown(): Promise<void> {
      cooldown.clear();
    },

    events: {
      messageCreate: async (ctx, message): Promise<void> => {
        if (areAutoRepliesSuppressed(message)) return;
        const registry = registryOf();
        // Logger is already bound to `{ plugin: 'auto-reply' }` by the host.
        const logger = ctx.logger;
        const t = ctx.translator;

        if (!message.channel.isSendable()) return;
        if (message.guildId === null) return;
        const guildId = message.guildId;
        const snapshot = settings?.get(guildId);
        if (
          settings !== undefined &&
          (snapshot === undefined ||
            !settings.isEnabled(
              guildId,
              'auto_reply',
              message.channelId,
              ancestorChannelIdsOf(message.channel, message.guild?.channels.cache),
            ))
        )
          return;
        const preferences = snapshot?.settings.autoReply;
        let release: (() => void) | undefined;
        let denied = false;
        const send = async (deliver: () => Promise<unknown>): Promise<void> => {
          if (denied) return;
          if (settings !== undefined && release === undefined) {
            release = cooldown.reserve(
              `${guildId}:${message.channelId}`,
              (preferences?.cooldownSeconds ?? 0) * 1000,
            );
            if (release === undefined) {
              denied = true;
              return;
            }
          }
          await deliver();
        };

        try {
          if ((preferences?.reactions ?? true) && message.content.includes(GOODNIGHT_LINE)) {
            await send(() => message.reply(t.t('replies:auto_reply.goodnight_reply')));
          }

          // The remaining behaviours all skip bot authors so two bots
          // running this plugin do not feedback-loop each other.
          if (!message.author.bot) {
            // Stored replies are member-authored, so they never ping anyone.
            const reply =
              preferences?.keywords === false
                ? null
                : await safeLookup(registry, guildId, message.content, logger, 'direct');
            if (reply !== null) {
              await send(() =>
                message.channel.send({ content: reply, allowedMentions: { parse: [] } }),
              );
            }

            for (const lucky of config.luckyReplies) {
              if (settings !== undefined && lucky.guildId !== guildId) continue;
              if (
                (preferences?.lucky ?? true) &&
                message.author.id === lucky.userId &&
                Math.random() < lucky.probability
              ) {
                // Operator-supplied text goes out verbatim, so mentions are
                // disabled: a stray `@everyone` in config.json would
                // otherwise become a ping.
                await send(() =>
                  message.channel.send({
                    content: lucky.reply,
                    allowedMentions: { parse: [] },
                  }),
                );
              }
            }

            if (
              (preferences?.random ?? true) &&
              Math.random() < (preferences?.probability ?? config.globalLuckyProbability)
            ) {
              const lucky = await safeLookup(registry, guildId, '[*]', logger, 'lucky');
              if (lucky !== null) {
                await send(() =>
                  message.channel.send({ content: lucky, allowedMentions: { parse: [] } }),
                );
              }
            }

            if ((preferences?.reactions ?? true) && LONG_HAIR_REGEX.test(message.content)) {
              await send(() => message.channel.send(t.t('replies:auto_reply.long_hair_line')));
            }

            const diceResult = preferences?.dice === false ? null : rollDice(message.content);
            if (diceResult !== null) {
              await send(() => message.channel.send(diceResult));
            }
          }
        } finally {
          release?.();
        }
      },
    },
  };
};
