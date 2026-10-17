import { describe, expect, it } from 'vitest';
import { bindTranslator } from '../../../../src/core/i18n';
import { buildFeedKeywordModal, renderFeedPanel } from '../../../../src/handlers/feed-panel/view';
import { buildPanel, panelComponents } from './helpers';

describe('platform-specific feed editor', () => {
  it.each([
    ['x', ['media']],
    ['bahamut', ['media']],
    ['youtube', []],
  ] as const)('shows only relevant controls for %s', (platformId, controls) => {
    const { bot, session } = buildPanel({ platformId });
    const rendered = renderFeedPanel(session, bindTranslator(bot.translator));
    const components = panelComponents(rendered);
    expect(components.map((component) => component.custom_id?.split('|')[2])).toEqual([
      ...controls,
      'keyword',
      'save',
      'cancel',
    ]);
    expect(rendered.content).toContain('replies:feed.panel.save_notice');
    expect(rendered.allowedMentions).toEqual({ parse: [] });
  });

  it('explicitly identifies a shared filter for batches', () => {
    const { bot, session } = buildPanel({ draft: { accounts: ['alpha', 'beta'] } });
    expect(renderFeedPanel(session, bindTranslator(bot.translator)).content).toContain(
      'replies:feed.panel.batch_notice',
    );
  });

  it('preloads the keyword and allows an empty modal submission', () => {
    const { bot, session } = buildPanel({
      draft: { filter: { media: 'any', keyword: 'live OR album' } },
    });
    const modal = buildFeedKeywordModal(session, 'nonce', bindTranslator(bot.translator)).toJSON();
    const row = modal.components[0];
    const field = row && 'components' in row ? row.components[0] : undefined;
    expect(field).toMatchObject({
      custom_id: 'keyword',
      value: 'live OR album',
      required: false,
      max_length: 100,
    });
    expect(modal.custom_id).toContain('|keyword_submit|nonce');
  });
});
