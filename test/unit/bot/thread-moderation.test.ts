import {
  MessageReferenceType,
  MessageType,
  MessageFlags,
  type Interaction,
  type Message,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { ThreadModeration, parseThreadModerationConfig } from '../../../src/bot/thread-moderation';
import type { Translator } from '../../../src/core/i18n';
import { createLogger } from '../../../src/core/logger';
import { err, ok } from '../../../src/core/result';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import type { ThreadModerationRepo } from '../../../src/persistence/repositories/thread-moderation.repo';

const thread = { id: 'thread', ownerId: 'owner', isThread: () => true };
const message = (overrides: Record<string, unknown> = {}) => {
  const data = {
    id: 'message',
    guildId: 'guild',
    channel: thread,
    author: { id: 'member', bot: false },
    partial: false,
    delete: vi.fn(async () => {}),
    ...overrides,
  };
  return { data, value: data as unknown as Message };
};
const interaction = (overrides: Record<string, unknown> = {}) => {
  const data = {
    guildId: 'guild',
    channelId: 'thread',
    channel: thread,
    user: { id: 'member' },
    isAutocomplete: () => false,
    isRepliable: () => true,
    reply: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    ...overrides,
  };
  return { data, value: data as unknown as Interaction };
};
const setup = (missingRepo = false) => {
  const isBlocked = vi.fn<ThreadModerationRepo['isBlocked']>(async () => ok(true));
  const recordMessageSource = vi.fn<ThreadModerationRepo['recordMessageSource']>(async () =>
    ok(undefined),
  );
  const findMessageSource = vi.fn<ThreadModerationRepo['findMessageSource']>(async () =>
    ok(undefined),
  );
  const repo = {
    isBlocked,
    recordMessageSource,
    findMessageSource,
    setBlocked: vi.fn(async () => ok(undefined)),
    listBlocked: vi.fn(async () => ok([])),
  };
  const logger = createLogger({ level: 'silent', pretty: false });
  const error = vi.spyOn(logger, 'error');
  const gate = new ThreadModeration({
    botId: 'bot',
    logger,
    translator: { t: (key: string) => key } as unknown as Translator,
    isAdmin: (id) => id === 'admin',
    getRepo: () => (missingRepo ? undefined : repo),
  });
  return { gate, isBlocked, error, recordMessageSource, findMessageSource };
};

describe('parseThreadModerationConfig', () => {
  it('defaults to disabled and accepts explicit booleans', () => {
    expect(parseThreadModerationConfig(undefined)).toBe(false);
    expect(parseThreadModerationConfig({ enabled: true })).toBe(true);
    expect(parseThreadModerationConfig({ enabled: false })).toBe(false);
  });

  it.each([null, {}, { enabled: 'true' }, { enabled: true, other: true }])(
    'rejects invalid settings %j',
    (value) => expect(() => parseThreadModerationConfig(value)).toThrow(),
  );
});

describe('ThreadModeration messages', () => {
  it('deletes blocked new messages before rejecting dispatch', async () => {
    const { gate, isBlocked } = setup();
    const target = message();
    expect(await gate.allowMessage(target.value, true)).toBe(false);
    expect(isBlocked).toHaveBeenCalledWith('bot', 'thread', 'member');
    expect(target.data.delete).toHaveBeenCalledOnce();
  });

  it('rejects updates without deleting old messages', async () => {
    const { gate } = setup();
    const target = message();
    expect(await gate.allowMessage(target.value, false)).toBe(false);
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['direct message', { guildId: null }],
    ['regular channel', { channel: { ...thread, isThread: () => false } }],
    ['thread owner', { author: { id: 'owner', bot: false } }],
    ['configured admin', { author: { id: 'admin', bot: false } }],
    ['bot', { author: { id: 'other-bot', bot: true } }],
  ])('passes %s without looking up restrictions', async (_name, overrides) => {
    const { gate, isBlocked } = setup();
    const target = message(overrides);
    expect(await gate.allowMessage(target.value, true)).toBe(true);
    expect(isBlocked).not.toHaveBeenCalled();
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it('passes unrestricted members', async () => {
    const { gate, isBlocked } = setup();
    isBlocked.mockResolvedValue(ok(false));
    const target = message();
    expect(await gate.allowMessage(target.value, true)).toBe(true);
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it.each([new Error('Missing Permissions'), { code: 10008 }])(
    'continues rejecting dispatch when deletion fails (%j)',
    async (failure) => {
      const { gate, error } = setup();
      const target = message();
      target.data.delete.mockRejectedValue(failure);
      expect(await gate.allowMessage(target.value, true)).toBe(false);
      expect(error).toHaveBeenCalledTimes(failure instanceof Error ? 1 : 0);
    },
  );

  it.each(['missing', 'error', 'throw'] as const)(
    'fails closed without deletion when the repository is %s',
    async (mode) => {
      const { gate, isBlocked, error } = setup(mode === 'missing');
      if (mode === 'error') {
        isBlocked.mockResolvedValue(
          err(databaseErrorFrom(new Error('offline'), { operation: 'test.isBlocked' })),
        );
      } else if (mode === 'throw') {
        isBlocked.mockRejectedValue(new Error('offline'));
      }
      const target = message();
      expect(await gate.allowMessage(target.value, true)).toBe(false);
      expect(target.data.delete).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
    },
  );

  it('fetches partial messages and deletes the resolved message', async () => {
    const { gate } = setup();
    const resolved = message();
    const fetch = vi.fn(async () => resolved.value);
    const partial = message({ partial: true, author: null, fetch });
    expect(await gate.allowMessage(partial.value, true)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(resolved.data.delete).toHaveBeenCalledOnce();
    expect(partial.data.delete).not.toHaveBeenCalled();
  });

  it('fails closed when fetching a partial message fails', async () => {
    const { gate, isBlocked } = setup();
    const target = message({ partial: true, fetch: vi.fn().mockRejectedValue(new Error('gone')) });
    expect(await gate.allowMessage(target.value, true)).toBe(false);
    expect(isBlocked).not.toHaveBeenCalled();
    expect(target.data.delete).not.toHaveBeenCalled();
  });
});

describe('ThreadModeration interactions', () => {
  it.each(['command', 'button', 'modal', 'select menu'])(
    'rejects blocked %s interactions with an ephemeral reply',
    async (kind) => {
      const { gate } = setup();
      const target = interaction({
        isChatInputCommand: () => kind === 'command',
        isButton: () => kind === 'button',
        isModalSubmit: () => kind === 'modal',
        isStringSelectMenu: () => kind === 'select menu',
      });
      expect(await gate.allowInteraction(target.value)).toBe(false);
      expect(target.data.reply).toHaveBeenCalledWith({
        content: 'replies:thread_moderation.blocked',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(target.data.respond).not.toHaveBeenCalled();
    },
  );

  it('answers blocked autocomplete with no suggestions', async () => {
    const { gate } = setup();
    const target = interaction({ isAutocomplete: () => true, isRepliable: () => false });
    expect(await gate.allowInteraction(target.value)).toBe(false);
    expect(target.data.respond).toHaveBeenCalledWith([]);
    expect(target.data.reply).not.toHaveBeenCalled();
  });

  it.each([
    { guildId: null },
    { channel: { ...thread, isThread: () => false } },
    { user: { id: 'owner' } },
    { user: { id: 'admin' } },
  ])('passes exempt interactions (%j)', async (overrides) => {
    const { gate, isBlocked } = setup();
    const target = interaction(overrides);
    expect(await gate.allowInteraction(target.value)).toBe(true);
    expect(isBlocked).not.toHaveBeenCalled();
    expect(target.data.reply).not.toHaveBeenCalled();
  });

  it('reports unavailable storage and rejects interactions', async () => {
    const { gate } = setup(true);
    const target = interaction();
    expect(await gate.allowInteraction(target.value)).toBe(false);
    expect(target.data.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:thread_moderation.unavailable' }),
    );
  });

  it('fetches uncached interaction channels before checking thread restrictions', async () => {
    const { gate, isBlocked } = setup();
    const fetch = vi.fn(async () => thread);
    const target = interaction({
      channel: null,
      channelId: 'thread',
      client: { channels: { fetch } },
    });
    expect(await gate.allowInteraction(target.value)).toBe(false);
    expect(fetch).toHaveBeenCalledWith('thread');
    expect(isBlocked).toHaveBeenCalledWith('bot', 'thread', 'member');
    expect(target.data.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:thread_moderation.blocked' }),
    );
  });

  it.each(['missing', 'failed'] as const)(
    'fails closed when an uncached interaction channel is %s',
    async (mode) => {
      const { gate, isBlocked } = setup();
      const fetch = vi.fn(async () => {
        if (mode === 'failed') throw new Error('Missing Access');
        return null;
      });
      const target = interaction({
        channel: null,
        channelId: 'thread',
        client: { channels: { fetch } },
      });
      expect(await gate.allowInteraction(target.value)).toBe(false);
      expect(isBlocked).not.toHaveBeenCalled();
      expect(target.data.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'replies:thread_moderation.unavailable' }),
      );
    },
  );

  it('replies within the interaction deadline when a lookup does not settle', async () => {
    vi.useFakeTimers();
    try {
      const { gate, isBlocked } = setup();
      isBlocked.mockImplementation(() => new Promise(() => {}));
      const target = interaction();
      const pending = gate.allowInteraction(target.value);
      await vi.advanceTimersByTimeAsync(1499);
      expect(target.data.reply).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(false);
      expect(target.data.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'replies:thread_moderation.unavailable' }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non-repliable blocked interactions without calling reply', async () => {
    const { gate } = setup();
    const target = interaction({ isRepliable: () => false });
    expect(await gate.allowInteraction(target.value)).toBe(false);
    expect(target.data.reply).not.toHaveBeenCalled();
  });
});

describe('ThreadModeration bot response sources', () => {
  const response = (overrides: Record<string, unknown> = {}) =>
    message({
      author: { id: 'external-bot', bot: true },
      interactionMetadata: { user: { id: 'member' } },
      ...overrides,
    });
  const reply = (overrides: Record<string, unknown> = {}) =>
    response({
      interactionMetadata: null,
      type: MessageType.Reply,
      reference: {
        type: MessageReferenceType.Default,
        channelId: 'thread',
        guildId: 'guild',
        messageId: 'original',
      },
      ...overrides,
    });

  it.each([true, false])(
    'removes a blocked external bot command response on create/update (%s)',
    async (created) => {
      const { gate, isBlocked, recordMessageSource } = setup();
      const target = response();
      expect(await gate.allowMessage(target.value, created)).toBe(false);
      expect(isBlocked).toHaveBeenCalledWith('bot', 'thread', 'member');
      expect(recordMessageSource).toHaveBeenCalledWith('bot', 'thread', 'message', 'member');
      expect(target.data.delete).toHaveBeenCalledOnce();
    },
  );

  it('supports legacy interaction metadata', async () => {
    const { gate } = setup();
    const target = response({ interactionMetadata: null, interaction: { user: { id: 'member' } } });
    expect(await gate.allowMessage(target.value, true)).toBe(false);
    expect(target.data.delete).toHaveBeenCalledOnce();
  });

  it('preserves an unblocked new interaction even when its message replies to a blocked user', async () => {
    const { gate, isBlocked, findMessageSource } = setup();
    isBlocked.mockResolvedValue(ok(false));
    const target = reply({ interactionMetadata: { user: { id: 'unblocked' } } });
    expect(await gate.allowMessage(target.value, true)).toBe(true);
    expect(isBlocked).toHaveBeenCalledWith('bot', 'thread', 'unblocked');
    expect(findMessageSource).not.toHaveBeenCalled();
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('preserves responses for exempt %s', async (actor) => {
    const { gate, isBlocked } = setup();
    const target = response({ interactionMetadata: { user: { id: actor } } });
    expect(await gate.allowMessage(target.value, true)).toBe(true);
    expect(isBlocked).not.toHaveBeenCalled();
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it('preserves responses for delegated managers whom the repository exempts', async () => {
    const { gate, isBlocked } = setup();
    isBlocked.mockResolvedValue(ok(false));
    const target = response();
    expect(await gate.allowMessage(target.value, true)).toBe(true);
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it('records a blocked original before deleting it', async () => {
    const { gate, recordMessageSource } = setup();
    const target = message();
    await gate.allowMessage(target.value, true);
    expect(recordMessageSource).toHaveBeenCalledWith('bot', 'thread', 'message', 'member');
    expect(recordMessageSource.mock.invocationCallOrder[0]).toBeLessThan(
      target.data.delete.mock.invocationCallOrder[0]!,
    );
  });

  it('deletes replies to removed originals using persistent storage after a fresh gate is constructed', async () => {
    const { gate, findMessageSource } = setup();
    findMessageSource.mockResolvedValue(ok('member'));
    const fetch = vi.fn().mockRejectedValue(new Error('Already deleted'));
    const target = reply({ channel: { ...thread, messages: { fetch } } });
    expect(await gate.allowMessage(target.value, true)).toBe(false);
    expect(findMessageSource).toHaveBeenCalledWith('bot', 'thread', 'original');
    expect(fetch).not.toHaveBeenCalled();
    expect(target.data.delete).toHaveBeenCalledOnce();
  });

  it('resolves an available original through its Discord author', async () => {
    const { gate } = setup();
    const fetch = vi.fn().mockResolvedValue(message().value);
    const target = reply({ channel: { ...thread, messages: { fetch } } });
    expect(await gate.allowMessage(target.value, true)).toBe(false);
    expect(fetch).toHaveBeenCalledWith('original');
    expect(target.data.delete).toHaveBeenCalledOnce();
  });

  it('preserves a reply to an unblocked original', async () => {
    const { gate, isBlocked } = setup();
    isBlocked.mockResolvedValue(ok(false));
    const fetch = vi.fn().mockResolvedValue(message().value);
    const target = reply({ channel: { ...thread, messages: { fetch } } });
    expect(await gate.allowMessage(target.value, true)).toBe(true);
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it('follows a bounded bot reply chain and persists the resolved source', async () => {
    const { gate, recordMessageSource } = setup();
    const original = response();
    const fetch = vi.fn().mockResolvedValue(original.value);
    const target = reply({ channel: { ...thread, messages: { fetch } } });
    expect(await gate.allowMessage(target.value, true)).toBe(false);
    expect(recordMessageSource).toHaveBeenCalledWith('bot', 'thread', 'message', 'member');
  });

  it('bounds reference fetching even for a cyclic chain', async () => {
    const { gate } = setup();
    const fetch = vi.fn();
    const target = reply({ channel: { ...thread, messages: { fetch } } });
    fetch.mockResolvedValue(target.value);
    expect(await gate.allowMessage(target.value, true)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(target.data.delete).not.toHaveBeenCalled();
  });

  it.each(['no-reference', 'cross-channel', 'cross-guild', 'forward', 'not-reply'])(
    'preserves a bot response with %s rather than guessing from mentions',
    async (kind) => {
      const { gate, findMessageSource, isBlocked } = setup();
      const reference = {
        type: MessageReferenceType.Default,
        channelId: 'thread',
        guildId: 'guild',
        messageId: 'original',
      };
      if (kind === 'cross-channel') reference.channelId = 'elsewhere';
      if (kind === 'cross-guild') reference.guildId = 'elsewhere';
      if (kind === 'forward') reference.type = MessageReferenceType.Forward;
      const target = reply({
        content: '<@member>',
        reference: kind === 'no-reference' ? null : reference,
        ...(kind === 'not-reply' ? { type: MessageType.Default } : {}),
      });
      expect(await gate.allowMessage(target.value, true)).toBe(true);
      expect(findMessageSource).not.toHaveBeenCalled();
      expect(isBlocked).not.toHaveBeenCalled();
      expect(target.data.delete).not.toHaveBeenCalled();
    },
  );

  it.each(['reference', 'storage', 'restriction', 'missing-storage'])(
    'preserves unverified bot responses when %s lookup fails',
    async (mode) => {
      const { gate, findMessageSource, isBlocked, error } = setup(mode === 'missing-storage');
      const failure = databaseErrorFrom(new Error('Offline'), { operation: 'test.messageSource' });
      if (mode === 'storage') findMessageSource.mockResolvedValue(err(failure));
      if (mode === 'restriction') isBlocked.mockResolvedValue(err(failure));
      const fetch = vi.fn().mockRejectedValue(new Error('Missing Access'));
      const target =
        mode === 'restriction'
          ? response()
          : reply({ channel: { ...thread, messages: { fetch } } });
      expect(await gate.allowMessage(target.value, true)).toBe(true);
      expect(target.data.delete).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
    },
  );

  it('still deletes confirmed blocked messages and suppresses dispatch when recording fails', async () => {
    const { gate, recordMessageSource, error } = setup();
    recordMessageSource.mockResolvedValue(
      err(databaseErrorFrom(new Error('Offline'), { operation: 'test.recordSource' })),
    );
    const target = message();
    expect(await gate.allowMessage(target.value, true)).toBe(false);
    expect(target.data.delete).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('suppresses dispatch when a confirmed bot response cannot be deleted', async () => {
    const { gate } = setup();
    const target = response();
    target.data.delete.mockRejectedValue(new Error('Missing Permissions'));
    expect(await gate.allowMessage(target.value, true)).toBe(false);
  });
});
