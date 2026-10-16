const edits = new Map<string, Promise<unknown>>();

/**
 * Serializes edits of one public archive message between the worker's progress
 * updates and button handlers in the same process.
 */
export async function withArchivePublicMessageLock<T>(
  channelId: string,
  messageId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([channelId, messageId]);
  const previous = edits.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  edits.set(key, current);
  try {
    return await current;
  } finally {
    if (edits.get(key) === current) edits.delete(key);
  }
}
