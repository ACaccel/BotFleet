/**
 * Pins the shared `/db` error reply: how it answers depending on the
 * interaction's acknowledgement state, which Discord errors it tolerates,
 * and when it logs.
 */
import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { DbInspectError, DomainError } from '../../../../src/core/errors';
import { dbFailure } from '../../../../src/handlers/commands/db-shared/failure';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { expiredInteractionError, markedTranslator, rejectedReplyError } from './fixtures';

/** An error whose message key is not in the catalog. */
class UnlistedError extends DomainError<'UNLISTED'> {
  public constructor() {
    super({
      code: 'UNLISTED',
      messageKey: 'replies:db_inspect.not_in_catalog',
      context: { operation: 'test' },
    });
  }
}

const FAILED = /^\[replies:db_inspect\.failed\]\{"traceId":"[0-9a-f]{8}"\}$/;
const EPHEMERAL = MessageFlags.Ephemeral;

const setup = (translated = true) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({ guildId: 'g-1', sink });
  const { bot, logger } = buildFakeBot(translated ? { translator: markedTranslator() } : {});
  return { sink, interaction, bot, logger };
};

describe('dbFailure reply channel', () => {
  it('replies privately when nothing has been acknowledged', async () => {
    const { sink, interaction, bot } = setup();

    await dbFailure(interaction, bot, new DbInspectError('DB_INSPECT_SESSION_EXPIRED'));

    expect(sink.replies).toEqual([
      { content: '[replies:db_inspect.session_expired]', flags: EPHEMERAL },
    ]);
    expect(sink.editReplies).toEqual([]);
    expect(sink.followUps).toEqual([]);
  });

  it('edits the deferred reply and clears its panel', async () => {
    const { sink, interaction, bot } = setup();
    await interaction.deferReply();

    await dbFailure(interaction, bot, new DbInspectError('DB_INSPECT_SESSION_EXPIRED'));

    expect(sink.editReplies).toEqual([
      {
        content: '[replies:db_inspect.session_expired]',
        embeds: [],
        components: [],
        files: [],
      },
    ]);
    expect(sink.replies).toEqual([]);
  });

  it('edits after a reply as well', async () => {
    const { sink, interaction, bot } = setup();
    await interaction.reply({ content: 'first' });

    await dbFailure(interaction, bot, new DbInspectError('DB_INSPECT_SESSION_EXPIRED'));

    expect(sink.editReplies).toHaveLength(1);
  });

  it('follows up privately instead of touching the panel when asked to keep the message', async () => {
    const { sink, interaction, bot } = setup();
    await interaction.deferReply();

    await dbFailure(interaction, bot, new DbInspectError('DB_INSPECT_NOT_INVOKER'), {
      keepMessage: true,
    });

    expect(sink.followUps).toEqual([
      { content: '[replies:db_inspect.not_invoker]', flags: EPHEMERAL },
    ]);
    expect(sink.editReplies).toEqual([]);
  });

  it('still replies when keepMessage is set but nothing was acknowledged', async () => {
    const { sink, interaction, bot } = setup();

    await dbFailure(interaction, bot, new DbInspectError('DB_INSPECT_NOT_INVOKER'), {
      keepMessage: true,
    });

    expect(sink.replies).toHaveLength(1);
    expect(sink.followUps).toEqual([]);
  });
});

describe('dbFailure message choice', () => {
  it('passes the error params to its message', async () => {
    const { sink, interaction, bot } = setup();

    await dbFailure(interaction, bot, new DbInspectError('DB_INSPECT_NOT_FOUND', { id: 'x1' }));

    expect(sink.replies[0]?.content).toBe('[replies:db_inspect.not_found]{"id":"x1"}');
  });

  it('does not log an expected DbInspectError', async () => {
    const { interaction, bot, logger } = setup();

    await dbFailure(
      interaction,
      bot,
      new DbInspectError('DB_INSPECT_UNKNOWN_GUILD', { guild: 'g' }),
    );

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls back to the generic failure when the key is missing from the catalog', async () => {
    const { sink, interaction, bot, logger } = setup(false);
    const error = new UnlistedError();

    await dbFailure(interaction, bot, error);

    expect(sink.replies[0]?.content).toBe('replies:db_inspect.failed');
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'errorLogger');
  });

  it('shows a trace ID for an unexpected error and logs it', async () => {
    const { sink, interaction, bot, logger } = setup();
    const error = new TypeError('secret detail');

    await dbFailure(interaction, bot, error);

    expect(sink.replies[0]?.content).toMatch(FAILED);
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'errorLogger');
  });

  it('copes with a thrown non-Error value', async () => {
    const { sink, interaction, bot, logger } = setup();

    await dbFailure(interaction, bot, 'plain string');

    expect(sink.replies[0]?.content).toMatch(FAILED);
    expect(logger.error).toHaveBeenCalledWith({ raw: 'plain string' }, 'errorLogger');
  });

  it('uses a fresh trace ID for each failure', async () => {
    const { sink, interaction, bot } = setup();

    await dbFailure(interaction, bot, new Error('a'));
    await dbFailure(interaction, bot, new Error('b'));

    const ids = sink.replies.map(
      (reply) => /"traceId":"([0-9a-f]{8})"/.exec(reply.content ?? '')?.[1],
    );
    expect(ids[0]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('dbFailure reply errors', () => {
  it.each(['reply', 'editReply', 'followUp'] as const)(
    'swallows an expired interaction when %s is refused',
    async (method) => {
      const { interaction, bot } = setup();
      if (method !== 'reply') await interaction.deferReply();
      vi.spyOn(interaction, method).mockRejectedValue(expiredInteractionError());

      await expect(
        dbFailure(interaction, bot, new Error('x'), { keepMessage: method === 'followUp' }),
      ).resolves.toBeUndefined();
    },
  );

  it('rethrows any other reply error', async () => {
    const { interaction, bot } = setup();
    const refusal = rejectedReplyError();
    vi.spyOn(interaction, 'reply').mockRejectedValue(refusal);

    await expect(dbFailure(interaction, bot, new Error('x'))).rejects.toBe(refusal);
  });
});
