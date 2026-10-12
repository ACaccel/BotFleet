/**
 * Unit coverage for the top-messages text: the preview is cut to 30
 * characters, inert (markdown and masked links escaped, mentions and custom
 * emoji turned into plain text, spoilers hidden), and a message without text
 * names what it carries. The text is a heading line, then each message with
 * its jump link and reaction counts, and nothing else.
 */
import { describe, expect, it } from 'vitest';

import {
  hotMessagesText,
  messagePreview,
  PREVIEW_LENGTH,
  type MentionNames,
} from '../../../../src/handlers/commands/traffic-shared/hot-messages';
import type { TopReactedMessage } from '../../../../src/persistence/repositories/archive-stats.types';

const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? `[${key}]` : `[${key}|${JSON.stringify(params)}]`;

const names: MentionNames = {
  user: (id) => (id === '111' ? 'Alice' : 'Unknown'),
  role: () => 'Mods',
  channel: (id) => (id === '222' ? 'general' : 'Unknown'),
};

const message = (overrides: Partial<TopReactedMessage> = {}): TopReactedMessage => ({
  messageId: 'm1',
  channelId: '222',
  createdTimestamp: Date.UTC(2026, 9, 8, 13, 34),
  author: { id: '111', username: 'alice' },
  content: 'hello',
  edited: false,
  attachments: [],
  stickers: [],
  totalReactions: 3,
  reactions: [{ key: '👍', name: '👍', count: 3 }],
  ...overrides,
});

const preview = (overrides: Partial<TopReactedMessage>): string =>
  messagePreview(message(overrides), names, t);

const graphemes = (text: string): number =>
  [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

describe('messagePreview', () => {
  it('keeps a short text and turns line breaks into spaces', () => {
    expect(preview({ content: 'line one\n\nline two' })).toBe('line one line two');
  });

  it('cuts a long text to 30 characters ending with an ellipsis', () => {
    const text = preview({ content: '一二三四五六七八九十'.repeat(5) });
    expect(graphemes(text)).toBe(PREVIEW_LENGTH);
    expect(text.endsWith('…')).toBe(true);
  });

  it('counts an emoji sequence as one character', () => {
    const text = preview({ content: '👨‍👩‍👧'.repeat(40) });
    expect(graphemes(text)).toBe(PREVIEW_LENGTH);
  });

  it('escapes markdown and masked links so nothing formats or links', () => {
    const text = preview({ content: '**b** [c](https://e.x) `x` ||' });
    expect(text).toContain('\\*\\*b\\*\\*');
    expect(text).toContain('\\[c](');
    expect(text).not.toMatch(/(^|[^\\])\[c\]\(/);
    expect(text).toContain('\\`x\\`');
    expect(text).toContain('\\|\\|');
  });

  it('turns mentions and custom emoji into plain text', () => {
    const text = preview({ content: '<@111> <@&5> <#222> <:blob:42>' });
    expect(text).toBe('@Alice @Mods #general :blob:');
    expect(preview({ content: '<@!999> </ping:7> <a:wave:8>' })).toBe('@Unknown /ping :wave:');
  });

  it('hides spoilers, even when the placeholder lands at the cut', () => {
    const hidden = preview({ content: 'answer: ||the butler did it|| ok' });
    expect(hidden).not.toContain('butler');
    expect(hidden).toContain('[replies:traffic.hot.spoiler]');
    const atCut = preview({ content: `${'a'.repeat(28)}||secret||${'b'.repeat(10)}` });
    expect(atCut).not.toContain('secret');
    expect(atCut).toContain('[replies:traffic.hot.spoiler]');
  });

  it('keeps a raw URL from becoming a link', () => {
    expect(preview({ content: 'go https://e.x now' })).toBe('go https://\u200Be.x now');
  });

  it('falls back to forwarded text and then the poll question', () => {
    expect(preview({ content: '', forwardedContent: 'fwd' })).toBe('fwd');
    expect(preview({ content: '', pollQuestion: 'Lunch?' })).toBe('Lunch?');
  });

  it('names what a message without text carries', () => {
    expect(
      preview({
        content: '',
        attachments: [{ contentType: 'image/png' }, { contentType: 'image/gif' }],
        stickers: [{ id: 's1' }],
      }),
    ).toBe(
      '[replies:traffic.hot.carries|{"items":"[replies:traffic.hot.images|{\\"count\\":2}][replies:traffic.list_separator][replies:traffic.hot.stickers|{\\"count\\":1}]"}]',
    );
    expect(preview({ content: '', attachments: [{ contentType: 'application/pdf' }] })).toContain(
      'hot.files',
    );
    expect(preview({ content: '', attachments: [{}], flags: 1 << 13 })).toContain('hot.voice');
    expect(preview({ content: '' })).toBe('[replies:traffic.hot.empty]');
  });
});

describe('hotMessagesText', () => {
  it('is omitted when no message has a reaction', () => {
    expect(
      hotMessagesText({
        messages: [],
        guildId: 'g',
        names,
        author: () => 'x',
        t,
      }),
    ).toBeUndefined();
  });

  it('lists each message under the heading with its jump link, author, channel and top reactions', () => {
    const text = hotMessagesText({
      messages: [
        message({
          reactions: [
            { key: '😂', name: '😂', count: 9 },
            { key: '42', emojiId: '42', name: 'blob', animated: true, count: 4 },
            { key: '👍', count: 2 },
            { key: '🎉', count: 1 },
          ],
          totalReactions: 16,
        }),
      ],
      guildId: 'g1',
      names,
      author: () => 'Alice_*',
      t,
    });
    const description = text ?? '';
    const [heading, line, meta, ...rest] = description.split('\n');
    expect(heading).toBe('[replies:traffic.hot.heading|{"count":1}]');
    expect(rest).toEqual([]);
    expect(line).toContain('"url":"https://discord.com/channels/g1/222/m1"');
    expect(meta).toContain('"author":"Alice\\\\_\\\\*"');
    expect(meta).toContain('"channel":"#general"');
    expect(meta).toContain('"top":"😂 9 · <a:blob:42> 4 · 👍 2"');
    // The meta line carries only author, channel and the top reactions.
    expect(meta).not.toContain('"number"');
    expect(meta).not.toContain('"time"');
    expect(description).not.toMatch(/delet/i);
  });
});
