const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Render only archived display fields; never expose execution payloads. */
export const structuredContentLines = (message: {
  embeds?: unknown;
  components?: unknown;
  poll?: unknown;
  snapshots?: unknown;
  reference?: unknown;
}): string[] => {
  const lines: string[] = [];
  const display = (value: unknown, depth = 0): void => {
    if (depth > 8) return;
    const object = record(value);
    for (const key of [
      'title',
      'description',
      'content',
      'label',
      'placeholder',
      'name',
      'text',
      'value',
      'url',
    ]) {
      if (typeof object[key] === 'string' && object[key].length > 0) lines.push(object[key]);
    }
    for (const key of ['author', 'footer', 'accessory', 'media'])
      if (object[key] !== undefined) display(object[key], depth + 1);
    for (const key of ['components', 'fields', 'options', 'items', 'embeds', 'attachments'])
      for (const child of list(object[key])) display(child, depth + 1);
  };
  for (const embed of list(message.embeds)) display(embed);
  for (const component of list(message.components)) display(component);
  for (const snapshot of list(message.snapshots)) display(snapshot);
  const poll = record(message.poll);
  const question = record(poll.question).text;
  if (typeof question === 'string') lines.push(question);
  const counts = new Map(
    list(record(poll.results).answer_counts).map((value) => {
      const count = record(value);
      return [count.id, count.count];
    }),
  );
  for (const answer of list(poll.answers)) {
    const value = record(answer);
    const text = record(value.poll_media).text;
    const count = counts.get(value.answer_id);
    if (typeof text === 'string')
      lines.push(typeof count === 'number' ? `${text}: ${count}` : text);
  }
  const reference = record(message.reference);
  const ids = [reference.guild_id, reference.channel_id, reference.message_id];
  if (ids.every((id) => typeof id === 'string' && /^\d+$/.test(id)))
    lines.push(`https://discord.com/channels/${ids.join('/')}`);
  return lines;
};
