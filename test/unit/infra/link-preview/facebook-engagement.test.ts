import { describe, expect, it } from 'vitest';

import { parseFacebookEngagement } from '../../../../src/infra/link-preview/providers/facebook-engagement';

const source = (summary: string): string => `facebed by pi.kt\n2026/10/13\n${summary}`;

describe('Facebook proxy engagement metadata', () => {
  it('extracts reactions, comments and shares from the source summary', () => {
    expect(parseFacebookEngagement(source('👍 🤗 708 • 💬 10 • 🔁 5'))).toEqual({
      likes: 708,
      comments: 10,
      shares: 5,
    });
  });

  it('handles other reaction types, variation selectors, grouped numbers and trailing image metadata', () => {
    expect(
      parseFacebookEngagement(source('❤️ 😂 1,234 · 💬 0 · 🔄 25\ncontains 4+ images')),
    ).toEqual({
      likes: 1234,
      comments: 0,
      shares: 25,
    });
  });

  it('preserves compact values without inventing exact counts', () => {
    expect(parseFacebookEngagement(source('👍 1.2K • 💬 10m • 🔁 0.5B'))).toEqual({
      likes: '1.2K',
      comments: '10m',
      shares: '0.5B',
    });
  });

  it('keeps real zeroes and omits unknown counts independently', () => {
    expect(parseFacebookEngagement(source('👍 null • 💬 0 • 🔁 0'))).toEqual({
      comments: 0,
      shares: 0,
    });
  });

  it.each([
    undefined,
    'Facebook',
    'other proxy\n👍 10 • 💬 20',
    source('👍 null • 💬 ? • 🔁 null'),
    source('👍 -1 • 💬 1.5 • 🔁 9007199254740992'),
    source('👍 12,34 • 💬 Infinity • 🔁 1e3'),
    source('👍 ' + '1'.repeat(33)),
    'facebed by ' + 'x'.repeat(4096),
  ])('omits unavailable or invalid metadata (%s)', (metadata) => {
    expect(parseFacebookEngagement(metadata)).toBeUndefined();
  });

  it('does not replace the first reported value with a later unrelated summary', () => {
    expect(parseFacebookEngagement(source('👍 10 • 💬 2 • 🔁 0\n👍 20 • 💬 4 • 🔁 1'))).toEqual({
      likes: 10,
      comments: 2,
      shares: 0,
    });
  });
});
