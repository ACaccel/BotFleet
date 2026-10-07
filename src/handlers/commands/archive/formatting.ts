/** Escape fence delimiters while preserving valid JSON string values. */
export const formatArchiveJson = (value: unknown): string =>
  `\`\`\`json\n${JSON.stringify(value, null, 2)?.replace(/`/g, '\\u0060') ?? 'null'}\n\`\`\``;

const chunks = (text: string, limit: number, preferLines: boolean): string[] => {
  const result: string[] = [];
  while (text.length > limit) {
    const newline = preferLines ? text.lastIndexOf('\n', limit - 1) : -1;
    const end = newline >= 0 ? newline + 1 : limit;
    result.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text.length > 0) result.push(text);
  return result;
};

/** Every Discord page must close its code fences independently. */
export const splitArchiveReply = (content: string): string[] => {
  const pages: string[] = [];
  let page = '';
  const parts = content.split(/(```json\n[\s\S]*?\n```)/g);
  for (const part of parts) {
    const fenced = part.startsWith('```json\n');
    const pieces = fenced
      ? chunks(part.slice(8, -4), 1_788, true).map((chunk) => `\`\`\`json\n${chunk}\n\`\`\``)
      : chunks(part, 1_800, false);
    for (const piece of pieces) {
      if (page.length + piece.length > 1_800) {
        if (page.length > 0) pages.push(page);
        page = '';
      }
      page += piece;
    }
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [''];
};
