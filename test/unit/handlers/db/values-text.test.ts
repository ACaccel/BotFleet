/**
 * Pins the `/db` text helpers (size limits, escaping, number formatting)
 * and the value renderers that panels and select-menu labels share.
 */
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import {
  FIELD_VALUE_LIMIT,
  codeBlock,
  dbReply,
  formatBytes,
  formatCount,
  joinLines,
  safeFileName,
  truncate,
} from '../../../../src/handlers/commands/db-shared/text';
import {
  conditionValue,
  discordTime,
  fieldMap,
  formatValue,
  guildLabel,
  operatorLabel,
  plainValue,
  sortLabel,
  summaryOf,
  timeOf,
} from '../../../../src/handlers/commands/db-shared/values';
import { echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { bindTranslator } from '../../../../src/core/i18n';
import { fakeClient, field } from './fixtures';

const t = bindTranslator(echoTranslatorWithParams());
const NO_NAMES: ReadonlyMap<string, string> = new Map();
const objectId = (hex: string) => ({ _bsontype: 'ObjectId', toString: () => hex });

describe('text helpers', () => {
  it('truncates only past the limit and marks the cut', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
    expect(truncate('abcdef', 5)).toBe('abcd…');
    expect(truncate('abc', 0)).toBe('…');
  });

  it('keeps stored triple backticks from closing the code block', () => {
    const block = codeBlock('json', 'a ``` b');
    expect(block.startsWith('```json\n')).toBe(true);
    expect(block.endsWith('\n```')).toBe(true);
    expect(block.slice(8, -4)).not.toContain('```');
  });

  it('limits attachment names to safe characters and 80 characters', () => {
    expect(safeFileName('json', 'bugtickets', 'a/b c')).toBe('bugtickets-a_b_c.json');
    expect(safeFileName('txt', 'x'.repeat(200))).toBe(`${'x'.repeat(80)}.txt`);
  });

  it('groups counts with thousands separators', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [1024 ** 5 * 3, '3072.0 TB'],
  ])('formats %d bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it('joins lines and drops the tail once the limit would be crossed', () => {
    expect(joinLines(['a', 'b', 'c'])).toBe('a\nb\nc');
    expect(joinLines([])).toBe('');
    expect(joinLines(['aaaa', 'bbbb', 'cccc'], 9)).toBe('aaaa\nbbbb');
    expect(joinLines(['aaaa', 'bb', 'cccccc'], 7)).toBe('aaaa\nbb');
    expect(joinLines(['x'.repeat(10)], FIELD_VALUE_LIMIT)).toBe('x'.repeat(10));
    // An over-long first line is cut rather than dropped, so the field is never empty.
    expect(joinLines(['x'.repeat(10), 'y'], 5)).toBe('xxxx…');
  });

  it('builds a reply that mentions nobody and clears earlier content', () => {
    const embed = new EmbedBuilder();
    expect(dbReply([embed])).toEqual({
      content: '',
      embeds: [embed],
      components: [],
      files: [],
      allowedMentions: { parse: [] },
    });
    const file = new AttachmentBuilder(Buffer.from('x'), { name: 'a.txt' });
    expect(dbReply([embed], { files: [file] }).files).toEqual([file]);
  });
});

describe('guildLabel', () => {
  it('shows the cached name with the ID', () => {
    expect(guildLabel(fakeClient({ g1: 'Guild One' }), 'g1', t)).toBe('Guild One (g1)');
  });

  it('marks a guild the bot has not joined', () => {
    expect(guildLabel(fakeClient(), 'g9', t)).toBe('g9 (replies:db_inspect.not_joined)');
  });
});

describe('time helpers', () => {
  it('accepts finite numbers and valid dates only', () => {
    expect(timeOf(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(timeOf(new Date(5))).toBe(5);
    expect(timeOf(Number.NaN)).toBeUndefined();
    expect(timeOf(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(timeOf(new Date('nope'))).toBeUndefined();
    expect(timeOf('2024-01-01')).toBeUndefined();
  });

  it('renders a Discord timestamp in whole seconds', () => {
    expect(discordTime(1_700_000_000_999)).toBe('<t:1700000000:f>');
  });
});

describe('plainValue', () => {
  const timestamp = field('at', { type: 'timestamp' });
  const date = field('when', { type: 'date' });

  it('shows a dash for null and undefined', () => {
    expect(plainValue(null, undefined, NO_NAMES)).toBe('—');
    expect(plainValue(undefined, undefined, NO_NAMES)).toBe('—');
  });

  it('renders timestamp and date fields as ISO minutes', () => {
    const ms = Date.UTC(2024, 0, 2, 3, 4, 5);
    expect(plainValue(ms, timestamp, NO_NAMES)).toBe('2024-01-02 03:04');
    expect(plainValue(new Date(ms), date, NO_NAMES)).toBe('2024-01-02 03:04');
  });

  it('falls through to the generic rendering when a time field holds no time', () => {
    expect(plainValue('soon', timestamp, NO_NAMES)).toBe('soon');
  });

  it('renders arrays by length', () => {
    expect(plainValue([1, 2, 3], undefined, NO_NAMES)).toBe('[3]');
  });

  it('names snowflakes known to the page, collapses whitespace and truncates', () => {
    expect(plainValue('123', undefined, new Map([['123', 'Alice']]))).toBe('Alice (123)');
    expect(plainValue('a \n\t  b', undefined, NO_NAMES)).toBe('a b');
    expect(plainValue('y'.repeat(100), undefined, NO_NAMES)).toBe(`${'y'.repeat(59)}…`);
  });

  it('renders ObjectId-like values as their hex string and other objects as {…}', () => {
    expect(plainValue(objectId('65a1b2c3d4e5f60718293a4b'), undefined, NO_NAMES)).toBe(
      '65a1b2c3d4e5f60718293a4b',
    );
    expect(plainValue({ a: 1 }, undefined, NO_NAMES)).toBe('{…}');
  });

  it('stringifies numbers, booleans and dates on untyped fields', () => {
    expect(plainValue(42, undefined, NO_NAMES)).toBe('42');
    expect(plainValue(false, undefined, NO_NAMES)).toBe('false');
    expect(plainValue(new Date(0), undefined, NO_NAMES)).toBe(String(new Date(0)));
  });
});

describe('formatValue', () => {
  it('renders valid times as Discord timestamps', () => {
    expect(formatValue(1_700_000_000_000, field('at', { type: 'timestamp' }), NO_NAMES)).toBe(
      '<t:1700000000:f>',
    );
    expect(formatValue(new Date(1_700_000_000_000), field('d', { type: 'date' }), NO_NAMES)).toBe(
      '<t:1700000000:f>',
    );
  });

  it('keeps the dash unescaped and escapes markdown elsewhere', () => {
    expect(formatValue(undefined, undefined, NO_NAMES)).toBe('—');
    expect(formatValue('*bold* _it_', undefined, NO_NAMES)).toBe('\\*bold\\* \\_it\\_');
  });

  it('falls back to plain text for a time field without a time', () => {
    expect(formatValue('later', field('at', { type: 'timestamp' }), NO_NAMES)).toBe('later');
  });
});

describe('summaryOf', () => {
  it('joins the summary fields, reading dotted paths', () => {
    const fields = fieldMap([field('author.username'), field('n', { type: 'number' })]);
    const document = { author: { username: 'a_b' }, n: 3 };
    expect(summaryOf(document, ['author.username', 'n', 'missing'], fields, NO_NAMES)).toBe(
      'a\\_b · 3 · —',
    );
    expect(summaryOf(document, ['author.username'], fields, NO_NAMES, plainValue)).toBe('a_b');
  });
});

describe('condition labels', () => {
  it('prints each value type', () => {
    const base = { field: 'f', operator: 'eq' } as const;
    expect(conditionValue({ ...base, value: 'text' })).toBe('text');
    expect(conditionValue({ ...base, value: 7 })).toBe('7');
    expect(conditionValue({ ...base, value: true })).toBe('true');
    expect(conditionValue({ ...base, value: new Date(0) })).toBe('1970-01-01T00:00:00.000Z');
    expect(conditionValue({ ...base, value: { objectId: 'abc123' } })).toBe('abc123');
  });

  it('labels substring as the contains operator', () => {
    expect(operatorLabel({ field: 'f', operator: 'substring', value: 'x' }, t)).toBe(
      'replies:db_inspect.operators.contains',
    );
    expect(operatorLabel({ field: 'f', operator: 'gt', value: 1 }, t)).toBe(
      'replies:db_inspect.operators.gt',
    );
  });

  it('labels a sort with its direction', () => {
    expect(sortLabel({ field: 'at', direction: 1 }, t)).toBe('at replies:db_inspect.sort.asc');
    expect(sortLabel({ field: 'at', direction: -1 }, t)).toBe('at replies:db_inspect.sort.desc');
  });
});
