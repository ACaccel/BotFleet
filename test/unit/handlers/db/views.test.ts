/**
 * Pins what the `/db` panels render: the list page (filter header, row
 * numbering, detail menu, page buttons), the schema view, a single document
 * and the stats view, including when text moves into an attachment.
 */
import { ButtonStyle, ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { PAGE_SIZE } from '../../../../src/application/db-inspect/service';
import { bindTranslator } from '../../../../src/core/i18n';
import { buildDocumentReply } from '../../../../src/handlers/commands/db-shared/document-view';
import { buildListReply } from '../../../../src/handlers/commands/db-shared/list-view';
import { buildSchemaReply } from '../../../../src/handlers/commands/db-shared/schema-view';
import { buildStatsReply } from '../../../../src/handlers/commands/db-shared/stats-view';
import { echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { EMBED_COLORS } from '../../../../src/infra/discord/presentation-colors';
import { description, documentView, embedJson, field, queryPage, rowJson } from './fixtures';

const t = bindTranslator(echoTranslatorWithParams());
const GUILD = 'Guild One (1)';
const GUILD_LINE = `replies:db_inspect.guild:${JSON.stringify({ guild: GUILD })}`;
const params = (key: string, values: Record<string, string | number>) =>
  `${key}:${JSON.stringify(values)}`;

const attachmentName = (file: unknown) => (file as { name: string }).name;
const attachmentText = (file: unknown) =>
  ((file as { attachment: Buffer }).attachment as Buffer).toString('utf8');

describe('list view', () => {
  it('shows one numbered row per document with the page footer', () => {
    const reply = buildListReply(queryPage(), GUILD, t);
    const embed = embedJson(reply.embeds?.[0]);

    expect(reply).toMatchObject({ content: '', allowedMentions: { parse: [] }, files: [] });
    expect(embed.title).toBe(params('replies:db_inspect.list.title', { collection: 'bugtickets' }));
    expect(embed.color).toBe(EMBED_COLORS.info);
    expect(embed.description).toBe(
      [GUILD_LINE, '', '`1.` `aaa` First bug · open', '`2.` `bbb` Second bug · closed'].join('\n'),
    );
    expect(embed.footer?.text).toBe(
      params('replies:db_inspect.list.footer', {
        page: 1,
        pages: 1,
        total: '2',
        sort: '_id replies:db_inspect.sort.desc',
      }),
    );
  });

  it('describes the filter, labelling substring as contains', () => {
    const page = queryPage({
      condition: { field: 'title', operator: 'substring', value: '*bug*' },
    });
    const { description: text } = embedJson(buildListReply(page, GUILD, t).embeds?.[0]);
    expect(text).toContain(
      params('replies:db_inspect.list.filter', {
        field: 'title',
        operator: 'replies:db_inspect.operators.contains',
        value: '\\*bug\\*',
      }),
    );
  });

  it('prints Date and ObjectId filter values as plain text', () => {
    const dated = queryPage({
      condition: { field: 'at', operator: 'gt', value: new Date(0) },
    });
    const byId = queryPage({
      condition: { field: '_id', operator: 'eq', value: { objectId: '65a1b2c3d4e5f60718293a4b' } },
    });
    expect(embedJson(buildListReply(dated, GUILD, t).embeds?.[0]).description).toContain(
      '1970-01-01T00:00:00.000Z',
    );
    expect(embedJson(buildListReply(byId, GUILD, t).embeds?.[0]).description).toContain(
      '65a1b2c3d4e5f60718293a4b',
    );
  });

  it('warns when the filter field has no index', () => {
    const lines = (flag: boolean) =>
      embedJson(buildListReply(queryPage({ unindexedFilter: flag }), GUILD, t).embeds?.[0])
        .description;
    expect(lines(true)).toContain('replies:db_inspect.list.unindexed');
    expect(lines(false)).not.toContain('replies:db_inspect.list.unindexed');
  });

  it('shows the empty state without a detail menu or page buttons', () => {
    const reply = buildListReply(
      queryPage({ documents: [], total: { count: 0, capped: false } }),
      GUILD,
      t,
    );
    expect(embedJson(reply.embeds?.[0]).description).toContain('replies:db_inspect.list.empty');
    expect(reply.components).toEqual([]);
  });

  it('offsets row numbers by the page and marks a capped total', () => {
    const page = queryPage({
      page: 2,
      pageCount: 5,
      total: { count: 10_000, capped: true },
    });
    const embed = embedJson(buildListReply(page, GUILD, t).embeds?.[0]);
    expect(embed.description).toContain('`21.` `aaa`');
    expect(embed.description).toContain('`22.` `bbb`');
    expect(embed.footer?.text).toBe(
      params('replies:db_inspect.list.footer', {
        page: 3,
        pages: 5,
        total: params('replies:db_inspect.list.total_capped', { count: '10,000' }),
        sort: '_id replies:db_inspect.sort.desc',
      }),
    );
  });

  it('truncates long IDs in rows and in the menu label', () => {
    const longId = 'z'.repeat(150);
    const reply = buildListReply(
      queryPage({ documents: [{ _id: longId, title: 'x', status: 'open' }] }),
      GUILD,
      t,
    );
    expect(embedJson(reply.embeds?.[0]).description).toContain(`\`${'z'.repeat(39)}…\``);
    const menu = rowJson(reply.components?.[0]).components[0];
    expect(menu?.options?.[0]?.label).toHaveLength(100);
    expect(menu?.options?.[0]?.label.endsWith('…')).toBe(true);
  });

  describe('detail menu', () => {
    it('offers one option per document, valued by its row index on the page', () => {
      const page = queryPage({ page: 1, pageCount: 2, token: 'tok9' });
      const reply = buildListReply(page, GUILD, t);
      const row = rowJson(reply.components?.[0]);

      expect(row.components).toHaveLength(1);
      const menu = row.components[0];
      expect(menu?.custom_id).toBe('db_view|tok9');
      expect(menu?.placeholder).toBe('replies:db_inspect.list.view_placeholder');
      expect(menu?.options).toEqual([
        { label: `${PAGE_SIZE + 1}. aaa`, value: '0', description: 'First bug · open' },
        { label: `${PAGE_SIZE + 2}. bbb`, value: '1', description: 'Second bug · closed' },
      ]);
    });

    it('omits the description of a document with an empty summary', () => {
      const page = queryPage({ summaryFields: [], documents: [{ _id: 'solo' }] });
      const menu = rowJson(buildListReply(page, GUILD, t).components?.[0]).components[0];
      expect(menu?.options).toEqual([{ label: '1. solo', value: '0' }]);
    });

    it('describes rows with plain times, since menu text is not markdown', () => {
      const ms = Date.UTC(2024, 0, 2, 3, 4);
      const page = queryPage({
        summaryFields: ['at'],
        fields: [field('at', { type: 'timestamp' })],
        documents: [{ _id: 'd1', at: ms }],
      });
      const reply = buildListReply(page, GUILD, t);
      const menu = rowJson(reply.components?.[0]).components[0];
      expect(menu?.options?.[0]?.description).toBe('2024-01-02 03:04');
      expect(embedJson(reply.embeds?.[0]).description).toContain(`<t:${ms / 1000}:f>`);
    });
  });

  describe('page buttons', () => {
    const buttons = (page: number, pageCount: number) =>
      rowJson(buildListReply(queryPage({ page, pageCount, token: 'tk' }), GUILD, t).components?.[1])
        .components;

    it('are absent when everything fits on one page', () => {
      expect(buildListReply(queryPage({ pageCount: 1 }), GUILD, t).components).toHaveLength(1);
    });

    it('disable the previous button on the first page', () => {
      const [previous, next] = buttons(0, 3);
      expect(previous).toMatchObject({ custom_id: 'db_page|tk|0', disabled: true, label: '◀' });
      expect(next).toMatchObject({ custom_id: 'db_page|tk|1', disabled: false, label: '▶' });
    });

    it('enable both buttons on a middle page', () => {
      const [previous, next] = buttons(1, 3);
      expect(previous).toMatchObject({ custom_id: 'db_page|tk|0', disabled: false });
      expect(next).toMatchObject({ custom_id: 'db_page|tk|2', disabled: false });
    });

    it('disable the next button on the last page', () => {
      const [previous, next] = buttons(2, 3);
      expect(previous).toMatchObject({ custom_id: 'db_page|tk|1', disabled: false });
      expect(next).toMatchObject({ custom_id: 'db_page|tk|2', disabled: true });
    });

    it('never share a custom ID, which Discord requires to be unique per message', () => {
      for (const [page, pageCount] of [
        [0, 2],
        [1, 2],
        [0, 3],
        [2, 3],
      ] as const) {
        const ids = buttons(page, pageCount).map((button) => button.custom_id);
        expect(new Set(ids).size).toBe(2);
      }
    });

    it('are secondary buttons in an action row', () => {
      const row = buildListReply(queryPage({ pageCount: 2 }), GUILD, t).components?.[1];
      const json = rowJson(row);
      expect(json.type).toBe(ComponentType.ActionRow);
      expect(
        json.components.every((c) => (c as { style?: number }).style === ButtonStyle.Secondary),
      ).toBe(true);
    });
  });
});

describe('schema view', () => {
  it('lists registered fields with their flags and the index keys', () => {
    const reply = buildSchemaReply(
      description({
        fields: [
          field('title'),
          field('number', { type: 'number', indexed: true }),
          field('status', { enumValues: ['open', 'closed'] }),
          field('user_id', { ref: 'user' }),
        ],
        indexes: [
          { name: 'a', keys: ['number'] },
          { name: 'b', keys: ['guild', 'status'] },
        ],
      }),
      GUILD,
      t,
    );
    const [fieldsEmbed] = reply.embeds ?? [];
    const json = embedJson(fieldsEmbed);

    expect(json.title).toBe(
      params('replies:db_inspect.schema.title', { collection: 'bugtickets' }),
    );
    expect(json.description).toBe(
      [
        GUILD_LINE,
        params('replies:db_inspect.schema.count', { count: '1,234' }),
        params('replies:db_inspect.schema.indexes', { indexes: 'number, guild+status' }),
        '',
        '`title` · string',
        '`number` · number · replies:db_inspect.indexed',
        '`status` · string · open | closed',
        '`user_id` · string · → user',
      ].join('\n'),
    );
    expect(reply.files).toEqual([]);
  });

  it('flags an unregistered collection with inferred fields and shows a dash for no indexes', () => {
    const reply = buildSchemaReply(
      description({ registered: false, inferred: true, indexes: [] }),
      GUILD,
      t,
    );
    const text = embedJson(reply.embeds?.[0]).description ?? '';
    expect(text).toContain('replies:db_inspect.schema.unregistered');
    expect(text).toContain('replies:db_inspect.schema.inferred');
    expect(text).toContain(params('replies:db_inspect.schema.indexes', { indexes: '—' }));
  });

  it('shows the newest document inline when it is short', () => {
    const reply = buildSchemaReply(description(), GUILD, t);
    const sample = embedJson(reply.embeds?.[1]);
    expect(sample.title).toBe('replies:db_inspect.schema.sample_title');
    expect(sample.description).toBe('```json\n{\n  "_id": "aaa",\n  "title": "First bug"\n}\n```');
    expect(reply.files).toEqual([]);
  });

  it('says so when the collection has no documents', () => {
    const { sample: _omitted, ...withoutSample } = description();
    const sample = embedJson(buildSchemaReply(withoutSample, GUILD, t).embeds?.[1]);
    expect(sample.description).toBe('replies:db_inspect.schema.no_sample');
    expect(sample.color).toBe(EMBED_COLORS.neutral);
    expect(sample.title).toBeUndefined();
  });

  it('attaches a long sample instead of inlining it', () => {
    const big = { _id: 'aaa', body: 'x'.repeat(4000) };
    const reply = buildSchemaReply(description({ sample: big }), GUILD, t);
    expect(embedJson(reply.embeds?.[1]).description).toBe('replies:db_inspect.document.attached');
    expect(reply.files).toHaveLength(1);
    expect(attachmentName(reply.files[0])).toBe('sample-bugtickets.json');
    expect(JSON.parse(attachmentText(reply.files[0]))).toEqual(big);
  });

  it('attaches the whole field list when it outgrows an embed', () => {
    const fields = Array.from({ length: 400 }, (_, i) => field(`field_number_${i}`));
    const reply = buildSchemaReply(description({ fields }), GUILD, t);

    expect(reply.files).toHaveLength(1);
    expect(attachmentName(reply.files[0])).toBe('schema-bugtickets.txt');
    const full = attachmentText(reply.files[0]);
    expect(full.length).toBeGreaterThan(4096);
    expect(full).toContain('`field_number_399` · string');
    const shown = embedJson(reply.embeds?.[0]).description ?? '';
    expect(shown.length).toBeLessThanOrEqual(4096);
    expect(shown).not.toContain('field_number_399');
  });

  it('adds both attachments when the schema text and the sample are long', () => {
    const fields = Array.from({ length: 400 }, (_, i) => field(`field_number_${i}`));
    const reply = buildSchemaReply(
      description({ fields, sample: { body: 'x'.repeat(4000) } }),
      GUILD,
      t,
    );
    expect(reply.files.map(attachmentName)).toEqual([
      'schema-bugtickets.txt',
      'sample-bugtickets.json',
    ]);
  });
});

describe('document view', () => {
  it('shows a short document as inline JSON with the guild in the footer', () => {
    const reply = buildDocumentReply(documentView(), GUILD, t);
    const embed = embedJson(reply.embeds?.[0]);

    expect(reply).toMatchObject({ content: '', files: [], allowedMentions: { parse: [] } });
    expect(embed.title).toBe(
      params('replies:db_inspect.document.title', { collection: 'bugtickets', id: 'aaa' }),
    );
    expect(embed.description).toBe('```json\n{\n  "_id": "aaa",\n  "title": "First bug"\n}\n```');
    expect(embed.footer?.text).toBe(GUILD);
    expect(embed.fields).toBeUndefined();
  });

  it('attaches a long document and points to the attachment', () => {
    const document = { _id: 'aaa', body: 'x'.repeat(4000) };
    const reply = buildDocumentReply(documentView({ document }), GUILD, t);

    expect(embedJson(reply.embeds?.[0]).description).toBe('replies:db_inspect.document.attached');
    expect(reply.files.map(attachmentName)).toEqual(['bugtickets-aaa.json']);
    expect(JSON.parse(attachmentText(reply.files[0]))).toEqual(document);
  });

  it('lists the Discord names a document refers to', () => {
    const names = new Map([
      ['111', '*Alice*'],
      ['222', 'general'],
    ]);
    const embed = embedJson(buildDocumentReply(documentView({ names }), GUILD, t).embeds?.[0]);
    expect(embed.fields).toEqual([
      { name: 'replies:db_inspect.document.names', value: '`111` \\*Alice\\*\n`222` general' },
    ]);
  });

  describe('messages collection', () => {
    const createdTimestamp = 1_700_000_000_000;
    const message = {
      _id: 'm1',
      content: 'hello <@123>',
      createdTimestamp,
      channelId: 'c1',
      author: { id: 'u1', username: 'al_ice' },
    };
    const view = (extra: Record<string, unknown> = {}, names = new Map<string, string>()) =>
      documentView({ collection: 'messages', document: { ...message, ...extra }, names });

    it('shows author, channel and time with the content as the description', () => {
      const reply = buildDocumentReply(view({}, new Map([['c1', 'general']])), GUILD, t);
      const embed = embedJson(reply.embeds?.[0]);

      expect(embed.color).toBe(EMBED_COLORS.info);
      expect(embed.description).toBe('hello <@123>');
      expect(embed.footer?.text).toBe(GUILD);
      expect(embed.fields).toEqual([
        { name: 'replies:db_inspect.message.author', value: 'al\\_ice (u1)', inline: true },
        { name: 'replies:db_inspect.message.channel', value: '<#c1> general', inline: true },
        { name: 'replies:db_inspect.message.time', value: '<t:1700000000:f>', inline: true },
        {
          name: 'replies:db_inspect.document.names',
          value: '`c1` general',
        },
      ]);
    });

    it('always attaches the full JSON', () => {
      const reply = buildDocumentReply(view(), GUILD, t);
      expect(reply.files.map(attachmentName)).toEqual(['messages-m1.json']);
      expect(JSON.parse(attachmentText(reply.files[0])).content).toBe('hello <@123>');
    });

    it('marks a deleted message with a neutral color and its deletion time', () => {
      const embed = embedJson(
        buildDocumentReply(view({ deletedAt: createdTimestamp + 60_000 }), GUILD, t).embeds?.[0],
      );
      expect(embed.color).toBe(EMBED_COLORS.neutral);
      expect(embed.fields?.at(-1)).toEqual({
        name: 'replies:db_inspect.message.deleted',
        value: '<t:1700000060:f>',
      });
    });

    it('lists the attachment URLs and skips malformed entries', () => {
      const embed = embedJson(
        buildDocumentReply(
          view({ attachments: [{ url: 'https://cdn.test/a.png' }, null, { url: 5 }, 'x'] }),
          GUILD,
          t,
        ).embeds?.[0],
      );
      expect(embed.fields?.at(-1)).toEqual({
        name: 'replies:db_inspect.message.attachments',
        value: 'https://cdn.test/a.png',
      });
    });

    it('falls back to dashes and the no-content text for a bare message', () => {
      const embed = embedJson(
        buildDocumentReply(
          documentView({ collection: 'messages', document: { _id: 'm2', attachments: 'nope' } }),
          GUILD,
          t,
        ).embeds?.[0],
      );
      expect(embed.description).toBe('replies:db_inspect.message.no_content');
      expect(embed.fields?.map((f) => f.value)).toEqual(['—', '—', '—']);
    });

    it('shows an author without a name or without an ID, and a channel with no known name', () => {
      const onlyId = embedJson(
        buildDocumentReply(view({ author: { id: 'u1' }, content: '' }), GUILD, t).embeds?.[0],
      );
      expect(onlyId.description).toBe('replies:db_inspect.message.no_content');
      expect(onlyId.fields?.[0]?.value).toBe('(u1)');
      expect(onlyId.fields?.[1]?.value).toBe('<#c1>');

      const onlyName = embedJson(
        buildDocumentReply(view({ author: { username: 'bob' } }), GUILD, t).embeds?.[0],
      );
      expect(onlyName.fields?.[0]?.value).toBe('bob');
    });
  });
});

describe('stats view', () => {
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    count: 1500,
    size: 10,
    storageSize: 2048,
    indexCount: 2,
    indexSize: 1024,
    registered: true,
    ...extra,
  });

  it('lists each collection and totals storage plus index size', () => {
    const reply = buildStatsReply(
      [entry('bugtickets'), entry('old_stuff', { registered: false })],
      GUILD,
      t,
    );
    const embed = embedJson(reply.embeds?.[0]);

    expect(reply).toMatchObject({ content: '', files: [], allowedMentions: { parse: [] } });
    expect(embed.title).toBe('replies:db_inspect.stats.title');
    expect(embed.description).toBe(
      [
        GUILD_LINE,
        params('replies:db_inspect.stats.total', { collections: 2, size: '6.0 KB' }),
        '',
        params('replies:db_inspect.stats.line', {
          name: 'bugtickets',
          count: '1,500',
          size: '2.0 KB',
          indexes: 2,
        }),
        params('replies:db_inspect.stats.line', {
          name: 'old_stuff (replies:db_inspect.unregistered)',
          count: '1,500',
          size: '2.0 KB',
          indexes: 2,
        }),
      ].join('\n'),
    );
  });

  it('shows the empty state for a database without collections', () => {
    const embed = embedJson(buildStatsReply([], GUILD, t).embeds?.[0]);
    expect(embed.description).toContain('replies:db_inspect.stats.empty');
    expect(embed.description).toContain(
      params('replies:db_inspect.stats.total', { collections: 0, size: '0 B' }),
    );
  });
});
