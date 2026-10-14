/**
 * `/bug_report` and its form submit. The ticket service itself is
 * covered in `test/unit/application/bug-report/tickets.test.ts`; here it
 * is stubbed so each of its outcomes can be mapped to what the reporter
 * is told, and so the deps the handler builds from the bot are visible.
 */
import { MessageFlags, type ModalBuilder } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BugReport from '../../../../src/handlers/commands/bug_report';
import BugReportModal from '../../../../src/handlers/modals/bug_report';
import { createTicket } from '../../../../src/application/bug-report/tickets';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  buildModalSubmitInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

vi.mock('../../../../src/application/bug-report/tickets', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createTicket: vi.fn(),
}));

const HUB = { guildId: '100000000000000001', channelId: '100000000000000002' };
const CONFIG = { bug_report: { hub: HUB } };

const createTicketMock = vi.mocked(createTicket);

beforeEach(() => {
  createTicketMock.mockReset();
  createTicketMock.mockResolvedValue({ status: 'created', number: 7, dmDelivered: true });
});

const botWith = (fields: Readonly<Record<string, unknown>> = {}) =>
  buildFakeBot({
    translator: echoTranslatorWithParams(),
    config: CONFIG,
    clientId: 'bot-1',
    personaName: 'Nijika',
    client: { user: { username: 'nijika-bot' } },
    connectionManager: undefined,
    isAdmin: (id: string) => id === 'admin',
    ...fields,
  }).bot;

describe('/bug_report', () => {
  it('opens the report form without replying', async () => {
    const sink = newInteractionSink();

    await new BugReport().execute(buildChatInputInteraction({ sink }), botWith());

    expect(sink.replies).toEqual([]);
    const modal = (sink.modals[0] as ModalBuilder).toJSON();
    expect(modal).toMatchObject({
      custom_id: 'bug_report',
      title: 'replies:bug_report.modal_title',
    });
    const [type, title, content] = modal.components;
    expect(type).toMatchObject({
      label: 'replies:bug_report.modal_type_label',
      component: {
        custom_id: 'type',
        options: [
          { value: 'bug', default: true },
          { value: 'suggestion', default: false },
          { value: 'other', default: false },
        ],
      },
    });
    expect(title).toMatchObject({ component: { custom_id: 'title', max_length: 100 } });
    expect(content).toMatchObject({ component: { custom_id: 'content', max_length: 1000 } });
  });

  it('fails startup for a bot without a hub forum', () => {
    expect(() => new BugReport().validateBotConfig({})).toThrow(/bug_report\.hub is required/);
    expect(() => new BugReport().validateBotConfig(CONFIG)).not.toThrow();
  });
});

describe('bug_report modal', () => {
  const submit = async (
    input: {
      type?: string;
      guildId?: string | null;
      bot?: ReturnType<typeof botWith>;
    } = {},
  ) => {
    const sink = newInteractionSink();
    await new BugReportModal().execute(
      buildModalSubmitInteraction({
        customId: 'bug_report',
        userId: 'reporter',
        ...(input.guildId === null
          ? { guildId: null }
          : { guild: buildGuild({ id: 'g-1', name: 'Guild' }) }),
        textInputs: { title: '  It broke  ', content: '  Steps to reproduce  ' },
        selectValues: { type: [input.type ?? 'suggestion'] },
        sink,
      }),
      input.bot ?? botWith(),
    );
    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    return sink.editReplies[0]?.content;
  };

  it('opens a ticket from the trimmed form and tells the reporter its number', async () => {
    const content = await submit();

    expect(content).toBe('replies:bug_report.created:{"number":7}');
    const [deps, args] = createTicketMock.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      reporter: { id: 'reporter' },
      source: { guildId: 'g-1', guildName: 'Guild', channelId: 'c-1' },
      type: 'suggestion',
      title: 'It broke',
      content: 'Steps to reproduce',
    });
    expect(deps).toMatchObject({ botId: 'bot-1', botLabel: 'Nijika', config: { hub: HUB } });
    expect(deps?.isAdmin('admin')).toBe(true);
    expect(deps?.isAdmin('reporter')).toBe(false);
    // Without MongoDB there is no ticket store, which the service reports as unavailable.
    expect(await deps?.tickets()).toBeUndefined();
  });

  it('records a report sent from DMs without a source and an unknown type as other', async () => {
    await submit({ guildId: null, type: 'tampered' });

    expect(createTicketMock.mock.calls[0]?.[1]).toMatchObject({ source: null, type: 'other' });
  });

  it('labels the post with the client username when the bot has no persona name', async () => {
    await submit({ bot: botWith({ personaName: '' }) });

    expect(createTicketMock.mock.calls[0]?.[0].botLabel).toBe('nijika-bot');
  });

  it.each([
    [
      { status: 'created', number: 7, dmDelivered: false },
      'replies:bug_report.created_no_dm:{"number":7}',
    ],
    [{ status: 'too_many', max: 3 }, 'replies:bug_report.too_many:{"max":3}'],
    [
      { status: 'cooldown', retryAt: 1_700_000_000_500 },
      'replies:bug_report.cooldown:{"at":"<t:1700000001:R>"}',
    ],
    [{ status: 'unavailable' }, 'replies:bug_report.unavailable'],
  ] as const)('answers the %o outcome', async (outcome, expected) => {
    createTicketMock.mockResolvedValueOnce(outcome);

    expect(await submit()).toBe(expected);
  });

  it('turns a service failure into the trace-stamped failure reply', async () => {
    createTicketMock.mockRejectedValueOnce(new Error('Missing Permissions'));

    expect(await submit()).toMatch(/^replies:bug_report\.failed:\{"traceId":"[0-9a-z]{6}"\}$/);
  });

  it('refuses the submit when the bot has no hub configured, opening nothing', async () => {
    const content = await submit({ bot: botWith({ config: {} }) });

    expect(content).toMatch(/^replies:bug_report\.failed:/);
    expect(createTicketMock).not.toHaveBeenCalled();
  });
});
