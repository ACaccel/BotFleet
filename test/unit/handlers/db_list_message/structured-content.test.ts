import { describe, expect, it } from 'vitest';
import { structuredContentLines } from '../../../../src/handlers/commands/db_list_message/structured-content';
import { formatMessageLines } from '../../../../src/handlers/commands/db_list_message/format-message-lines';
describe('extended archive transcript', () => {
  it('renders readable components and polls without execution identifiers', () => {
    const lines = structuredContentLines({
      components: [
        {
          type: 1,
          custom_id: 'secret-action',
          components: [{ label: 'Register', url: 'https://example.com' }],
        },
      ],
      poll: {
        question: { text: 'Which day?' },
        answers: [{ answer_id: 1, poll_media: { text: 'Sunday' } }],
        results: { answer_counts: [{ id: 1, count: 4 }] },
      },
    });
    expect(lines).toEqual(['Register', 'https://example.com', 'Which day?', 'Sunday: 4']);
  });
  it('labels unknown/deleted content without inventing authors or timestamps', async () => {
    const lines = await formatMessageLines(
      [{ deletion: { deletedAt: 1 }, presence: { content: 'unknown' } }],
      {
        resolveDisplayName: async () => {
          throw new Error('must not lookup unknown author');
        },
        t: (key) => key,
      },
    );
    expect(lines.join()).toContain('--:--');
    expect(lines.join()).toContain('archive.deleted');
    expect(lines.join()).toContain('archive.content_unknown');
    expect(lines.join()).not.toContain('[empty]');
  });
});
