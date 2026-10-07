import { describe, expect, it, vi } from 'vitest';
import { publishDeletedArchivePlan } from '../../../../src/handlers/commands/archive/deleted-plan-message';
import { withArchivePublicMessageLock } from '../../../../src/infra/archive/public-message';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const reference = { channelId: '223456789012345678', messageId: '323456789012345678' };
const route = `/channels/${reference.channelId}/messages/${reference.messageId}`;
const status = {
  description: 'Original plan status',
  timestamp: '2026-10-06T00:00:00.000Z',
  footer: { text: 'Archive status' },
  color: 0x5865f2,
};

const fixture = (message: unknown) => {
  const rest = {
    get: vi.fn().mockResolvedValue(message),
    patch: vi.fn().mockResolvedValue(undefined),
  };
  return { ...buildFakeBot({ client: { rest } }), rest };
};

describe('deleted archive plan notices', () => {
  it('replaces the original status card after plan deletion', async () => {
    const f = fixture({ embeds: [status], components: [] });

    await publishDeletedArchivePlan(f.bot, reference);

    expect(f.rest.get).toHaveBeenCalledWith(route);
    expect(f.rest.patch).toHaveBeenCalledWith(route, {
      body: {
        content: 'replies:archive.manage_deleted',
        embeds: [],
        attachments: [],
        components: [
          {
            type: 1,
            components: [expect.objectContaining({ custom_id: 'archive_manage|plans|first' })],
          },
        ],
        allowed_mentions: { parse: [] },
      },
    });
  });

  it.each([
    ['another item detail', { embeds: [{ description: 'Another plan changes' }], components: [] }],
    ['legacy standalone plan', { embeds: [{ description: 'Old plan notice' }], components: [] }],
    [
      'bulk cleanup',
      {
        content: 'Bulk cleanup progress',
        embeds: [],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                custom_id: 'archive_manage|bulk-result|11111111-1111-4111-8111-111111111111',
                label: 'Cleanup result',
                style: 2,
              },
            ],
          },
        ],
      },
    ],
    ['empty panel', { embeds: [], components: [] }],
  ])('preserves %s without a recognizable status card', async (_name, message) => {
    const f = fixture(message);

    await publishDeletedArchivePlan(f.bot, reference);

    expect(f.rest.get).toHaveBeenCalledWith(route);
    expect(f.rest.patch).not.toHaveBeenCalled();
  });

  it('reads the panel after an earlier navigation edit finishes', async () => {
    const f = fixture({ embeds: [status], components: [] });
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const navigation = withArchivePublicMessageLock(
      reference.channelId,
      reference.messageId,
      async () => {
        await pending;
        f.rest.get.mockResolvedValue({ embeds: [{ description: 'Another item' }], components: [] });
      },
    );
    const deletion = publishDeletedArchivePlan(f.bot, reference);

    expect(f.rest.get).not.toHaveBeenCalled();
    release();
    await navigation;
    await deletion;

    expect(f.rest.get).toHaveBeenCalledOnce();
    expect(f.rest.patch).not.toHaveBeenCalled();
  });

  it('keeps the panel unchanged when reading its current state fails', async () => {
    const f = fixture({ embeds: [status], components: [] });
    const error = new Error('Discord read failed');
    f.rest.get.mockRejectedValue(error);

    await publishDeletedArchivePlan(f.bot, reference);

    expect(f.rest.patch).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith(
      { err: error },
      'Could not replace deleted archive plan notice',
    );
  });
});
