import type { Message } from 'discord.js';

// Weak references retain the decision across async dispatch without retaining messages.
const suppressedMessages = new WeakSet<Message>();

/** Mark synchronously before plugin listeners receive a moderated message. */
export const suppressAutoReplies = (message: Message): void => {
  suppressedMessages.add(message);
};

export const areAutoRepliesSuppressed = (message: Message): boolean =>
  suppressedMessages.has(message);
