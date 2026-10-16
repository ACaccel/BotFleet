/**
 * Pins `/db` autocomplete: non-admins and a missing service get nothing,
 * each option asks the service for exactly what it needs and labels the
 * answer, and a rejected lookup is silent unless it is a real fault.
 */
import { describe, expect, it } from 'vitest';

import { DbInspectError } from '../../../../src/core/errors';
import db from '../../../../src/handlers/commands/db';
import { suggestDbOptions } from '../../../../src/handlers/commands/db/autocomplete';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildAutocompleteInteraction } from '../../../fixtures/discord/interaction-builder';
import { ADMIN_ID, GUILD_ID, fakeService, markedTranslator } from './fixtures';

interface RunOptions {
  readonly focusedOption: string;
  readonly focused?: string;
  readonly options?: Record<string, string>;
  readonly guildId?: string | null;
  readonly userId?: string;
  readonly withService?: boolean;
  readonly marked?: boolean;
}

const setup = (run: RunOptions) => {
  const { service, mocks } = fakeService();
  const { bot } = buildFakeBot({
    isAdmin: (id: string) => id === ADMIN_ID,
    ...(run.marked === false ? {} : { translator: markedTranslator() }),
    ...(run.withService === false ? {} : { dbInspectService: service }),
  });
  const interaction = buildAutocompleteInteraction({
    commandName: 'db',
    userId: run.userId ?? ADMIN_ID,
    guildId: run.guildId === undefined ? GUILD_ID : run.guildId,
    focusedOption: run.focusedOption,
    focused: run.focused ?? '',
    options: run.options ?? {},
  });
  return { mocks, suggest: () => suggestDbOptions(interaction, bot), bot, interaction };
};

describe('/db autocomplete access', () => {
  it('offers a non-admin nothing and never queries', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'guild', userId: 'someone-else' });

    expect(await suggest()).toEqual([]);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it('offers nothing when the service is not published', async () => {
    const { suggest } = setup({ focusedOption: 'guild', withService: false });

    expect(await suggest()).toEqual([]);
  });

  it('is wired to the command as its autocomplete hook', async () => {
    const { mocks, bot, interaction } = setup({ focusedOption: 'guild', focused: 'gu' });
    mocks['suggestGuilds']?.mockResolvedValue([{ id: '1', name: 'Guild', sizeOnDisk: 1 }]);

    expect(await new db().autocomplete(interaction, bot)).toEqual([
      { name: 'Guild (1)', value: '1' },
    ]);
  });
});

describe('/db autocomplete options', () => {
  it('guild: labels joined guilds by name and others as not joined', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'guild', focused: 'gu' });
    mocks['suggestGuilds']?.mockResolvedValue([
      { id: '1', name: 'Guild One', sizeOnDisk: 1 },
      { id: '2', sizeOnDisk: 1 },
    ]);

    expect(await suggest()).toEqual([
      { name: 'Guild One (1)', value: '1' },
      { name: '[replies:db_inspect.not_joined] (2)', value: '2' },
    ]);
    expect(mocks['suggestGuilds']).toHaveBeenCalledWith('gu', GUILD_ID);
  });

  it('guild: still works in a DM, passing no current guild', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'guild', guildId: null });
    mocks['suggestGuilds']?.mockResolvedValue([]);

    expect(await suggest()).toEqual([]);
    expect(mocks['suggestGuilds']).toHaveBeenCalledWith('', null);
  });

  it('collection: describes registered and unregistered names with approximate counts', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'collection', focused: 'b' });
    mocks['suggestCollections']?.mockResolvedValue([
      { name: 'bugtickets', estimatedCount: 12_345, registered: true },
      { name: 'leftover_feature', estimatedCount: 7, registered: false },
    ]);

    expect(await suggest()).toEqual([
      {
        name: 'bugtickets · [replies:db_inspect.collections.bugtickets] · ~12,345',
        value: 'bugtickets',
      },
      {
        name: 'leftover_feature · [replies:db_inspect.unregistered] · ~7',
        value: 'leftover_feature',
      },
    ]);
    expect(mocks['suggestCollections']).toHaveBeenCalledWith(GUILD_ID, 'b');
  });

  it('collection: omits the description of a registered name the catalog does not describe', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'collection', marked: false });
    mocks['suggestCollections']?.mockResolvedValue([
      { name: 'bugtickets', estimatedCount: 3, registered: true },
    ]);

    expect(await suggest()).toEqual([{ name: 'bugtickets · ~3', value: 'bugtickets' }]);
  });

  it('collection: uses the guild option over the current guild', async () => {
    const { mocks, suggest } = setup({
      focusedOption: 'collection',
      options: { guild: '200000000000000002' },
    });
    mocks['suggestCollections']?.mockResolvedValue([]);

    await suggest();

    expect(mocks['suggestCollections']).toHaveBeenCalledWith('200000000000000002', '');
  });

  it('offers nothing without a database, as in a DM with no guild chosen', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'collection', guildId: null });

    expect(await suggest()).toEqual([]);
    expect(mocks['suggestCollections']).not.toHaveBeenCalled();
  });

  it.each(['field', 'operator', 'value', 'sort', 'id'])(
    '%s: offers nothing until a collection is chosen',
    async (focusedOption) => {
      for (const options of [{}, { collection: '' }] as Array<Record<string, string>>) {
        const { mocks, suggest } = setup({ focusedOption, options });

        expect(await suggest()).toEqual([]);
        for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
      }
    },
  );

  it('field: shows each path with its type and whether it is indexed', async () => {
    const { mocks, suggest } = setup({
      focusedOption: 'field',
      focused: 'ti',
      options: { collection: 'bugtickets' },
    });
    mocks['suggestFields']?.mockResolvedValue([
      { path: 'title', type: 'string', indexed: false },
      { path: 'number', type: 'number', indexed: true },
    ]);

    expect(await suggest()).toEqual([
      { name: 'title · string', value: 'title' },
      { name: 'number · number · [replies:db_inspect.indexed]', value: 'number' },
    ]);
    expect(mocks['suggestFields']).toHaveBeenCalledWith(GUILD_ID, 'bugtickets', 'ti');
  });

  it('operator: translates each operator for the chosen field', async () => {
    const { mocks, suggest } = setup({
      focusedOption: 'operator',
      options: { collection: 'bugtickets', field: 'title' },
    });
    mocks['suggestOperators']?.mockResolvedValue(['eq', 'contains']);

    expect(await suggest()).toEqual([
      { name: '[replies:db_inspect.operators.eq]', value: 'eq' },
      { name: '[replies:db_inspect.operators.contains]', value: 'contains' },
    ]);
    expect(mocks['suggestOperators']).toHaveBeenCalledWith(GUILD_ID, 'bugtickets', 'title');
  });

  it('operator: asks without a field when none is chosen yet', async () => {
    const { mocks, suggest } = setup({
      focusedOption: 'operator',
      options: { collection: 'bugtickets' },
    });
    mocks['suggestOperators']?.mockResolvedValue([]);

    await suggest();

    expect(mocks['suggestOperators']).toHaveBeenCalledWith(GUILD_ID, 'bugtickets', undefined);
  });

  it('value: passes field, operator and what has been typed', async () => {
    const { mocks, suggest } = setup({
      focusedOption: 'value',
      focused: 'op',
      options: { collection: 'bugtickets', field: 'status', operator: 'eq' },
    });
    mocks['suggestValues']?.mockResolvedValue([{ label: 'open (4)', value: 'open' }]);

    expect(await suggest()).toEqual([{ name: 'open (4)', value: 'open' }]);
    expect(mocks['suggestValues']).toHaveBeenCalledWith(
      GUILD_ID,
      'bugtickets',
      'status',
      'eq',
      'op',
    );
  });

  it('sort: encodes each order as field:direction', async () => {
    const { mocks, suggest } = setup({
      focusedOption: 'sort',
      options: { collection: 'bugtickets' },
    });
    mocks['suggestSorts']?.mockResolvedValue([
      { field: '_id', direction: -1 },
      { field: 'number', direction: 1 },
    ]);

    expect(await suggest()).toEqual([
      { name: '_id [replies:db_inspect.sort.desc]', value: '_id:desc' },
      { name: 'number [replies:db_inspect.sort.asc]', value: 'number:asc' },
    ]);
    expect(mocks['suggestSorts']).toHaveBeenCalledWith(GUILD_ID, 'bugtickets');
  });

  describe('id', () => {
    it('summarises each document by the collection summary fields', async () => {
      const { mocks, suggest } = setup({
        focusedOption: 'id',
        focused: 'a',
        options: { collection: 'bugtickets' },
      });
      mocks['suggestIds']?.mockResolvedValue([
        { id: 'aaa', document: { number: 5, title: 'two\n  words', status: 'open', extra: 'x' } },
        { id: 'bbb', document: { title: true, status: null } },
      ]);

      expect(await suggest()).toEqual([
        { name: 'aaa · 5 · two words · open', value: 'aaa' },
        { name: 'bbb', value: 'bbb' },
      ]);
      expect(mocks['suggestIds']).toHaveBeenCalledWith(GUILD_ID, 'bugtickets', 'a');
    });

    it('drops IDs too long for a choice value', async () => {
      const { mocks, suggest } = setup({
        focusedOption: 'id',
        options: { collection: 'bugtickets' },
      });
      mocks['suggestIds']?.mockResolvedValue([
        { id: 'k'.repeat(101), document: {} },
        { id: 'k'.repeat(100), document: {} },
      ]);

      expect(await suggest()).toEqual([{ name: 'k'.repeat(100), value: 'k'.repeat(100) }]);
    });

    it('shows bare IDs for a collection the catalog does not know', async () => {
      const { mocks, suggest } = setup({
        focusedOption: 'id',
        options: { collection: 'leftover_feature' },
      });
      mocks['suggestIds']?.mockResolvedValue([{ id: 'x1', document: { title: 'ignored' } }]);

      expect(await suggest()).toEqual([{ name: 'x1', value: 'x1' }]);
    });
  });

  it('offers nothing for an option it does not know', async () => {
    const { mocks, suggest } = setup({
      focusedOption: 'mystery',
      options: { collection: 'bugtickets' },
    });

    expect(await suggest()).toEqual([]);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
});

describe('/db autocomplete failures', () => {
  it('offers nothing when the service rejects with a domain error', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'collection' });
    mocks['suggestCollections']?.mockRejectedValue(
      new DbInspectError('DB_INSPECT_UNKNOWN_GUILD', { guild: GUILD_ID }),
    );

    expect(await suggest()).toEqual([]);
  });

  it('rethrows an unexpected error so the dispatcher can log it', async () => {
    const { mocks, suggest } = setup({ focusedOption: 'guild' });
    mocks['suggestGuilds']?.mockRejectedValue(new Error('boom'));

    await expect(suggest()).rejects.toThrow('boom');
  });
});
