import { describe, expect, it } from 'vitest';

import { renderActivity, type ActivityView } from '../../../src/application/activity/activity-view';
import type { BoundTranslate } from '../../../src/core/i18n';

const t = ((key: string) => key) as BoundTranslate;

const view = (overrides: Partial<ActivityView> = {}): ActivityView => ({
  title: 'Board games',
  expired_at: Date.UTC(2026, 9, 20),
  participants: ['u1', 'u2'],
  capacity: 10,
  role_id: 'r1',
  ...overrides,
});

const buttonIds = (rendered: ReturnType<typeof renderActivity>) =>
  rendered.components.flatMap((row) =>
    (row as unknown as { components: { data: { custom_id?: string } }[] }).components.map(
      (button) => button.data.custom_id,
    ),
  );

describe('renderActivity', () => {
  it('offers join, withdraw, roll call and close while open', () => {
    const rendered = renderActivity(view(), t);
    expect(buttonIds(rendered)).toEqual([
      'activity|join',
      'activity|leave',
      'activity|rollcall',
      'activity|close',
    ]);
    const fields = (rendered.embeds[0] as { data: { fields: { value: string }[] } }).data.fields;
    expect(fields.map((field) => field.value)).toContain('2 / 10');
    expect(fields.map((field) => field.value)).toContain('<@&r1>');
  });

  it('keeps only the roll call once closed, and nothing once cancelled', () => {
    expect(buttonIds(renderActivity(view({ status: 'closed' }), t))).toEqual(['activity|rollcall']);
    expect(renderActivity(view({ status: 'cancelled' }), t).components).toEqual([]);
  });

  it('shows the latest attendance', () => {
    const rendered = renderActivity(view({ attendance: [{ present: ['u1'], total: 2 }] }), t);
    const fields = (rendered.embeds[0] as { data: { fields: { name: string; value: string }[] } })
      .data.fields;
    expect(fields.find((field) => field.name === 'replies:activity.field_attendance')?.value).toBe(
      '1 / 2',
    );
  });
});
