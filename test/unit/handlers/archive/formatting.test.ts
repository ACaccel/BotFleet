import { describe, expect, it } from 'vitest';
import {
  formatArchiveJson,
  splitArchiveReply,
} from '../../../../src/handlers/commands/archive/formatting';

describe('archive report formatting', () => {
  it('renders indented JSON and escapes embedded fence delimiters without changing values', () => {
    const value = { status: 'queued', counts: { total: 3 }, label: '```' };
    const report = formatArchiveJson(value);
    expect(report).toContain('```json\n{\n  "status": "queued",');
    expect(report).toContain('\n    "total": 3\n');
    expect(JSON.parse(report.slice(8, -4))).toEqual(value);
    expect(report.match(/```/g)).toHaveLength(2);
  });

  it('keeps every overflow code block closed and preserves the full JSON', () => {
    const value = { records: Array.from({ length: 100 }, (_, id) => ({ id, status: 'complete' })) };
    const report = formatArchiveJson(value);
    const pages = splitArchiveReply(`Summary\n${report}\nNext: 100`);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 1800)).toBe(true);
    expect(pages.every((page) => (page.match(/```/g)?.length ?? 0) % 2 === 0)).toBe(true);
    const reconstructed = pages
      .flatMap((page) => [...page.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]))
      .join('');
    expect(JSON.parse(reconstructed)).toEqual(value);
    expect(pages.join('')).toContain('Summary');
    expect(pages.join('')).toContain('Next: 100');
  });

  it('bounds individual long values and preserves their characters across pages', () => {
    const report = formatArchiveJson({ value: 'x'.repeat(4000) });
    const pages = splitArchiveReply(report);
    expect(pages.every((page) => page.length <= 1800)).toBe(true);
    expect(pages.map((page) => page.slice(8, -4)).join('')).toBe(report.slice(8, -4));
  });
});
