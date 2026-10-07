import { ComponentType } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccessModule from '../../../../src/handlers/commands/archive/access';
import Actions from '../../../../src/handlers/select-menus/archive_actions';
import {
  resolveArchiveReference,
  shortArchiveReference,
} from '../../../../src/handlers/commands/archive/manage-references';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  dispatch: vi.fn(),
  publish: vi.fn(),
  failure: vi.fn(),
}));
vi.mock('../../../../src/handlers/commands/archive/access', async (original) => ({
  ...(await original<typeof AccessModule>()),
  requireArchiveAccess: mocks.access,
}));
vi.mock('../../../../src/handlers/commands/archive/manage-dispatch', () => ({
  dispatchArchiveManagement: mocks.dispatch,
}));
vi.mock('../../../../src/handlers/commands/archive/replies', () => ({
  publishArchiveReply: mocks.publish,
  archiveFailure: mocks.failure,
}));
const bot = () => buildFakeBot({ client: { user: { id: 'bot' } } }).bot;
const fixture = (value = 'delete-job|guild:job') => ({
  customId: 'archive_actions',
  user: { id: 'manager' },
  channelId: 'debug',
  values: [value],
  message: {
    id: 'card',
    author: { id: 'bot' },
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: 'archive_actions',
            options: [{ value }],
          },
        ],
      },
    ],
  },
  deferUpdate: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ guildId: 'guild' });
  mocks.dispatch.mockResolvedValue({ content: 'confirmation' });
});

describe('legacy archive more actions menu', () => {
  it('routes deletion to the existing actor-bound confirmation flow', async () => {
    const interaction = fixture();
    const host = bot();
    await new Actions().execute(interaction as never, host);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      'delete-job',
      'guild:job',
      interaction,
      host,
      { guildId: 'guild' },
    );
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(
      interaction,
      { content: 'confirmation' },
      host,
      { guildId: 'guild' },
    );
    expect(mocks.failure).not.toHaveBeenCalled();
  });
  it('allows another authorized manager to use the shared menu', async () => {
    const interaction = fixture('rollback|run');
    interaction.user.id = 'another-manager';
    await new Actions().execute(interaction as never, bot());
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith(interaction, expect.anything());
    expect(mocks.dispatch).toHaveBeenCalledWith(
      'rollback',
      'run',
      interaction,
      expect.anything(),
      expect.anything(),
    );
  });
  it.each(['audit|guild', 'verify|run', 'attachment|guild', 'delete-confirm|token'])(
    'rejects unexposed action %s even on an offered option',
    async (value) => {
      await new Actions().execute(fixture(value) as never, bot());
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.failure).toHaveBeenCalledOnce();
    },
  );
  it.each(['bot', 'option', 'customId', 'multiple', 'malformed'] as const)(
    'rejects invalid %s interactions',
    async (kind) => {
      const interaction = fixture();
      if (kind === 'bot') interaction.message.author.id = 'other';
      if (kind === 'option') interaction.values = ['rollback|run'];
      if (kind === 'customId') interaction.customId = 'other';
      if (kind === 'multiple') interaction.values.push('delete-job|guild:job');
      if (kind === 'malformed') {
        interaction.values = ['delete-job|'];
        interaction.message.components[0]!.components[0]!.options = [{ value: 'delete-job|' }];
      }
      await new Actions().execute(interaction as never, bot());
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.failure).toHaveBeenCalledOnce();
    },
  );
  it('rechecks guild authorization before dispatch', async () => {
    mocks.access.mockRejectedValueOnce(new Error('denied'));
    await new Actions().execute(fixture() as never, bot());
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.failure).toHaveBeenCalledOnce();
  });
  it('keeps long operation identities intact through bounded option references', async () => {
    const host = bot();
    const id = 'r'.repeat(160);
    const value = `ref|${shortArchiveReference('rollback', id)}`;
    expect(value.length).toBeLessThanOrEqual(100);
    expect(resolveArchiveReference(value.slice(4))).toMatchObject({ action: 'rollback', id });
    await new Actions().execute(fixture(value) as never, host);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      'rollback',
      id,
      expect.anything(),
      host,
      expect.anything(),
    );
  });
});
