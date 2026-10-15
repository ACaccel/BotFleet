/** Notification relay embed: stage marks, status colors and labels, and Discord limits. */
import { describe, expect, it } from 'vitest';

import { EMBED_COLORS } from '../../../src/infra/discord/presentation-colors';
import { renderNotification } from '../../../src/plugins/notification-relay/internal/render';
import {
  NotificationSchema,
  type Notification,
} from '../../../src/plugins/notification-relay/internal/request';
import { echoTranslator } from '../../fixtures/runtime';

const AT = new Date('2026-10-15T08:00:00.000Z');

const base: Notification = { title: 'Deploy b5ffd42', stages: [], status: 'running' };

describe('renderNotification', () => {
  it('marks every stage state and lists stages after the description', () => {
    const embed = renderNotification(
      {
        ...base,
        description: 'fix(chat): restack messages',
        stages: [
          { label: 'Fetch', state: 'done' },
          { label: 'Build', state: 'running' },
          { label: 'Test', state: 'pending' },
          { label: 'Migrate', state: 'skipped' },
          { label: 'Restart', state: 'failed' },
        ],
      },
      echoTranslator(),
      AT,
    );

    expect(embed.description).toBe(
      'fix(chat): restack messages\n\n✓ Fetch\n● Build\n○ Test\n– Migrate\n✗ Restart',
    );
    expect(embed.timestamp).toBe(AT.toISOString());
    expect(embed.title).toBe('Deploy b5ffd42');
  });

  it.each([
    ['running', EMBED_COLORS.info],
    ['succeeded', EMBED_COLORS.success],
    ['failed', EMBED_COLORS.error],
    ['cancelled', EMBED_COLORS.neutral],
  ] as const)('shows %s through its color and translated label', (status, color) => {
    const embed = renderNotification({ ...base, status }, echoTranslator(), AT);

    expect(embed.color).toBe(color);
    expect(embed.fields).toEqual([
      {
        name: 'replies:notification_relay.status_field',
        value: `replies:notification_relay.status.${status}`,
      },
    ]);
  });

  it('adds the link and summary, and omits an empty description', () => {
    const embed = renderNotification(
      { ...base, url: 'https://example.com/run/1', summary: 'Took 3m 12s', description: '' },
      echoTranslator(),
      AT,
    );

    expect(embed.url).toBe('https://example.com/run/1');
    expect(embed.description).toBeUndefined();
    expect(embed.fields?.[1]).toEqual({
      name: 'replies:notification_relay.summary_field',
      value: 'Took 3m 12s',
    });
  });

  it('stays within Discord embed limits for the largest accepted request', () => {
    const largest = NotificationSchema.parse({
      title: 't'.repeat(256),
      description: 'd'.repeat(3000),
      url: `https://example.com/${'p'.repeat(400)}`,
      stages: Array.from({ length: 10 }, () => ({ label: 'l'.repeat(100), state: 'running' })),
      status: 'failed',
      summary: 's'.repeat(500),
    });
    const embed = renderNotification(largest, echoTranslator(), AT);
    const total =
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);

    expect(embed.description?.length).toBeLessThanOrEqual(4096);
    expect(embed.fields?.every((f) => f.value.length <= 1024)).toBe(true);
    expect(total).toBeLessThanOrEqual(6000);
  });
});

describe('NotificationSchema', () => {
  it.each([
    ['an unknown field', { ...base, color: 1 }],
    ['an unknown stage field', { ...base, stages: [{ label: 'a', state: 'done', at: 1 }] }],
    ['an unknown state', { ...base, stages: [{ label: 'a', state: 'queued' }] }],
    ['an unknown status', { ...base, status: 'done' }],
    ['an empty title', { ...base, title: '' }],
    ['eleven stages', { ...base, stages: Array(11).fill({ label: 'a', state: 'done' }) }],
    ['a non-http URL', { ...base, url: 'javascript:alert(1)' }],
    ['a missing stage list', { title: 't', status: 'running' }],
  ])('rejects %s', (_label, body) => {
    expect(NotificationSchema.safeParse(body).success).toBe(false);
  });
});
