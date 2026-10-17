import path from 'node:path';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { bindTranslator } from '../../../src/core/i18n';
import { loadCatalogResources } from '../../../src/core/i18n/catalog-loader';
import { I18NextTranslator } from '../../../src/core/i18n/i18next-translator';
import { buildCommandJsonBody } from '../../../src/handlers/commands/command-builder';
import { localizeCommandConfig } from '../../../src/handlers/commands/command';
import { createCommand } from '../../../src/handlers/commands';
import {
  formatOutcomePages,
  formatOutcomesForLog,
} from '../../../src/handlers/commands/feed_subscribe/format-outcomes';
import { formatSubscriptionPages } from '../../../src/handlers/commands/feed_list/format-subscriptions';
import { buildAccountSuggestions } from '../../../src/handlers/commands/feed_unsubscribe/account-suggestions';
import {
  formatRemovedForLog,
  formatRemovedForReply,
} from '../../../src/handlers/feed-removed-list';
import { formatFeedTarget } from '../../../src/handlers/feed-target-label';
import type { FeedSubscriptionDoc } from '../../../src/persistence/schemas/feed-subscription.schema';

const resources = loadCatalogResources({
  localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
});

const doc = (account: string): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform: 'bahamut',
  account,
  channel_id: 'chan-1',
  created_by: 'u-1',
  created_at: 1_700_000_000_000,
  filter: { media: 'any' },
  last_seen_timestamp: 1_700_000_100,
});

describe.each(['en', 'zh-TW'] as const)('feed target integration in %s', (locale) => {
  it('uses translated board/thread labels on every subscription surface', async () => {
    const translator = await I18NextTranslator.create(resources, locale);
    const t = bindTranslator(translator);
    const docs = [doc('board:36476'), doc('board:36476:3'), doc('36476/3047')];
    const pages = formatSubscriptionPages(docs, t).join('\n');
    const removed = formatRemovedForReply(docs, t);
    const outcomes = docs.map(({ account }) => ({ account, status: 'created' as const }));
    const subscribed = formatOutcomePages(
      outcomes,
      {
        platform: 'Bahamut',
        platformId: 'bahamut',
        channel: '<#chan-1>',
        filter: { media: 'any' },
      },
      t,
    ).join('\n');
    const suggestions = buildAccountSuggestions(docs, { focused: '' }, t);
    expect(suggestions.map(({ value }) => value)).toEqual(docs.map(({ account }) => account));
    for (const { account } of docs) {
      const key = account.startsWith('board:') ? 'target_board' : 'target_thread';
      const expected = translator.tStrict(`replies:feed.${key}`, { account });
      expect(formatFeedTarget('bahamut', account, t)).toBe(expected);
      for (const text of [
        pages,
        removed,
        subscribed,
        suggestions.map(({ name }) => name).join('\n'),
      ]) {
        expect(text).toContain(expected);
        expect(text).not.toContain(`@${account}`);
      }
    }
    expect(pages).toContain(
      translator.tStrict('replies:feed.checked_through', {
        timestamp: '<t:1700000100:R>',
      }),
    );
    expect(pages).not.toContain(translator.tStrict('replies:feed.never_forwarded'));
    for (const { name, value } of suggestions) {
      expect(name.length).toBeLessThanOrEqual(100);
      expect(value.length).toBeLessThanOrEqual(100);
    }
    expect(formatRemovedForLog(docs)).not.toContain('@');
    expect(formatOutcomesForLog(outcomes, 'bahamut')).not.toContain('@');
  });

  it('describes an untouched Bahamut cursor as not checked yet', async () => {
    const translator = await I18NextTranslator.create(resources, locale);
    const { last_seen_timestamp: _timestamp, ...unchecked } = doc('36476/3047');
    const rendered = formatSubscriptionPages([unchecked], bindTranslator(translator)).join('\n');
    expect(rendered).toContain(translator.tStrict('replies:feed.never_checked'));
  });

  it('preserves handle prefixes for X and custom platforms', async () => {
    const translator = await I18NextTranslator.create(resources, locale);
    const t = bindTranslator(translator);
    expect(formatFeedTarget('x', 'alice', t)).toBe('@alice');
    expect(formatFeedTarget('fake', 'alice', t)).toBe('@alice');
    const [page] = formatOutcomePages(
      [{ account: 'alice', status: 'created' }],
      {
        platform: 'X (Twitter)',
        platformId: 'x',
        channel: '<#chan-1>',
        filter: { media: 'media_only' },
      },
      t,
    );
    expect(page).toContain('**@alice**');
    expect(page).not.toContain('@@');
  });

  it('registers real translated options and choices within Discord limits', async () => {
    const translator = await I18NextTranslator.create(resources, locale);
    const strict = {
      t: translator.tStrict.bind(translator),
      tStrict: translator.tStrict.bind(translator),
      listMissingKeys: translator.listMissingKeys.bind(translator),
    };
    const command = createCommand('feed');
    expect(command).toBeDefined();
    const body = buildCommandJsonBody(localizeCommandConfig(command!.config, strict)) as {
      description: string;
      options: {
        name: string;
        description: string;
        options?: {
          name: string;
          description: string;
          choices?: { name: string; value: string }[];
        }[];
      }[];
    };
    expect(body.description.length).toBeLessThanOrEqual(100);
    for (const subcommand of body.options) {
      expect(subcommand.description.length).toBeLessThanOrEqual(100);
      for (const option of subcommand.options ?? []) {
        expect(option.description.length).toBeGreaterThan(0);
        expect(option.description.length).toBeLessThanOrEqual(100);
        expect(option.description).not.toContain('commands:');
        for (const choice of option.choices ?? []) {
          expect(choice.name.length).toBeLessThanOrEqual(100);
        }
      }
      if (subcommand.name !== 'list') {
        expect(subcommand.options?.find(({ name }) => name === 'platform')?.choices).toEqual([
          { name: 'X (Twitter)', value: 'x' },
          { name: 'Bahamut', value: 'bahamut' },
        ]);
      }
    }
  });

  it('renders parent-owned Bahamut errors and target refusals without unresolved parameters', async () => {
    const translator = await I18NextTranslator.create(resources, locale);
    for (const key of [
      'bahamut_resolution_required',
      'bahamut_lookback_exceeded',
      'invalid_target',
    ]) {
      const text = translator.tStrict(`errors:feed.${key}`, {
        platform: 'Bahamut',
        account: '36476/3047',
        status: '200',
      });
      expect(text).not.toContain('{{');
      expect(text).not.toContain('@36476/3047');
    }
    expect(
      translator.tStrict('errors:feed.bahamut_lookback_exceeded', {
        platform: 'Bahamut',
        account: '36476/3047',
        status: '200',
      }),
    ).toContain('maxPages');
    expect(translator.tStrict('replies:feed.no_accounts')).toContain('target');
  });
});
