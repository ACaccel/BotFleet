import { Collection, type Message } from 'discord.js';

/**
 * Build a guild `Message` stand-in. Defaults cover the fields most
 * message paths read first — ids, a human author, an empty attachment
 * collection, `partial: false` — and `fields` overrides or extends them
 * with whatever the code under test reads next.
 *
 * `fields` is an open record for the same reason as `buildFakeBot`: a
 * `Partial<Message>` would demand real discord.js values the stubs
 * neither have nor need.
 */
export const buildMessage = (fields: Readonly<Record<string, unknown>> = {}): Message =>
  ({
    id: 'm1',
    content: '',
    guildId: 'g1',
    channelId: 'c1',
    partial: false,
    author: {
      id: 'u1',
      bot: false,
      username: 'user',
      displayName: 'User',
      displayAvatarURL: () => 'https://example.test/a.png',
    },
    attachments: new Collection(),
    ...fields,
  }) as unknown as Message;
