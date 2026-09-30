/**
 * AutoReplyPlugin — Discord `messageCreate` subscriber that drives the
 * auto-reply behaviour as a self-contained plugin.
 *
 * Behaviours:
 *   - Hard-coded reaction to the "肥貓晚安" line (fires even for bots).
 *   - DB-backed reply lookup via `ReplyRepo.findByInput`; random pick
 *     when multiple replies match the same input.
 *   - Per-user lucky replies, declared in the operator's `auto_reply`
 *     config block (see `./config.ts`).
 *   - Global lucky "[*]" reply at the configured probability.
 *   - `長髮男` regex reply.
 *   - `<count>d<sides>` dice expression with 0 < count < 100 and
 *     0 < sides < 2^30 bounds.
 *
 * Factory pattern (mirrors `createSocialLinkPreviewPlugin`): the
 * operator config is parsed once and captured in the closure, so the
 * returned object is pure data.
 *
 * DI: the plugin resolves {@link GuildRegistry} once in `init` and the
 * subscription closes over it, so a message event costs no container
 * lookup.
 */
import { areAutoRepliesSuppressed } from '../../infra/discord/suppressed-auto-replies';
import { TOKENS } from '../../bot/tokens';
import type { GuildRegistry } from '../../bot/guild-registry';
import type { Logger } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import { requireCapture } from '../../core/regex-capture';
import { parseAutoReplyConfig } from './config';

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

export const createAutoReplyPlugin = (rawConfig?: unknown): Plugin => {
  const config = parseAutoReplyConfig(rawConfig);
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

        if (message.content.includes(GOODNIGHT_LINE)) {
          await message.reply(t.t('replies:auto_reply.goodnight_reply'));
        }

        // The remaining behaviours all skip bot authors so two bots
        // running this plugin do not feedback-loop each other.
        if (!message.author.bot) {
          const reply = await safeLookup(registry, guildId, message.content, logger, 'direct');
          if (reply !== null) {
            await message.channel.send({ content: reply });
          }

          for (const lucky of config.luckyReplies) {
            if (message.author.id === lucky.userId && Math.random() < lucky.probability) {
              // Operator-supplied text goes out verbatim, so mentions are
              // disabled: a stray `@everyone` in config.json would
              // otherwise become a ping.
              await message.channel.send({
                content: lucky.reply,
                allowedMentions: { parse: [] },
              });
            }
          }

          if (Math.random() < config.globalLuckyProbability) {
            const lucky = await safeLookup(registry, guildId, '[*]', logger, 'lucky');
            if (lucky !== null) {
              await message.channel.send({ content: lucky });
            }
          }

          if (LONG_HAIR_REGEX.test(message.content)) {
            await message.channel.send(t.t('replies:auto_reply.long_hair_line'));
          }

          const diceResult = rollDice(message.content);
          if (diceResult !== null) {
            await message.channel.send(diceResult);
          }
        }
      },
    },
  };
};
