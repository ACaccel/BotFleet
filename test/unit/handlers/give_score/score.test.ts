import { describe, expect, it } from 'vitest';

import { scoreFor } from '../../../../src/handlers/commands/give_score/score';
import zh from '../../../../src/i18n/locales/zh-TW/replies.json';
import en from '../../../../src/i18n/locales/en/replies.json';

const NOON = Date.UTC(2026, 9, 14, 12);
const DAY = 24 * 60 * 60_000;

describe('scoreFor', () => {
  it('gives the same subject the same score all day, ignoring case', () => {
    expect(scoreFor('Dinner', 'UTC', NOON)).toEqual(scoreFor('dinner', 'UTC', NOON + 60_000));
  });

  it('stays within 0-10 apart from the rare 11 and -1', () => {
    for (let day = 0; day < 400; day += 1) {
      const { score } = scoreFor('subject', 'UTC', NOON + day * DAY);
      expect([-1, ...Array.from({ length: 12 }, (_, i) => i)]).toContain(score);
    }
  });

  it('only picks comments that exist in every catalog', () => {
    for (let day = 0; day < 400; day += 1) {
      for (const subject of ['a', 'b', 'c']) {
        const key =
          scoreFor(subject, 'UTC', NOON + day * DAY)
            .commentKey.split('.')
            .at(-1) ?? '';
        expect(zh.give_score.comment).toHaveProperty(key);
        expect(en.give_score.comment).toHaveProperty(key);
      }
    }
  });
});
