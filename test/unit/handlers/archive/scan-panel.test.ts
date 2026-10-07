import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import type { ArchiveControlService } from '../../../../src/infra/archive/control';
import { archiveScanReply } from '../../../../src/handlers/buttons/archive_panel/scan-panel';
import { publishArchiveReply } from '../../../../src/handlers/commands/archive/replies';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const fixture = async () => {
  const translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: 'en',
  });
  const { bot } = buildFakeBot({ translator });
  const sink = newInteractionSink();
  const interaction = buildButtonInteraction({
    customId: 'archive_panel|scan|scan-1',
    guild: buildGuild({ id: '1' }),
    sink,
  });
  const periodicStatus = vi.fn().mockResolvedValue({
    runId: 'scan-1',
    progress: sanitizeArchiveProgress({
      work: 'periodic',
      state: 'running',
      phase: 'history',
      scanId: 'scan-1',
      messages: { scanned: 12 },
    }),
  });
  const progressDetails = vi
    .fn()
    .mockResolvedValue({ activities: [], gaps: [], page: 2, hasNext: true });
  const control = { periodicStatus, progressDetails } as unknown as ArchiveControlService;
  return { bot, translator, sink, interaction, control, periodicStatus, progressDetails };
};

describe('periodic archive private panel', () => {
  it('does not relabel a newer current scan as an old notification result', async () => {
    const { bot, translator, interaction, control, progressDetails } = await fixture();
    const reply = await archiveScanReply(interaction, bot, control, 'old-scan', null);
    expect(reply.content).toBe(translator.t('replies:archive.periodic_unavailable'));
    expect(reply.content).not.toContain('scan-1');
    expect(reply.components).toEqual([]);
    expect(progressDetails).not.toHaveBeenCalled();
  });

  it('reuses the private reply and reads one bounded detail page per navigation', async () => {
    const { bot, interaction, control, sink, progressDetails } = await fixture();
    await interaction.deferUpdate();
    const reply = await archiveScanReply(interaction, bot, control, 'scan-1', 2);
    await publishArchiveReply(interaction, reply);
    const controls = JSON.stringify(reply.components);
    expect(controls).toContain('archive_panel|scan|scan-1|p|1');
    expect(controls).toContain('archive_panel|scan|scan-1|p|3');
    expect(progressDetails).toHaveBeenCalledExactlyOnceWith('scan-1', 2, 1);
    expect(sink.editReplies).toHaveLength(1);
    expect(sink.followUps).toHaveLength(0);
  });

  it('does not offer a page beyond the supported detail limit', async () => {
    const { bot, interaction, control, progressDetails } = await fixture();
    progressDetails.mockResolvedValue({ activities: [], gaps: [], page: 100_000, hasNext: true });
    const reply = await archiveScanReply(interaction, bot, control, 'scan-1', 100_000);
    expect(JSON.stringify(reply.components)).not.toContain('p|100001');
    expect(JSON.stringify(reply.components)).toContain('p|99999');
  });
});
