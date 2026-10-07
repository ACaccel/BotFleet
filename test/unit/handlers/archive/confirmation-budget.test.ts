import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import type { ArchiveControlService } from '../../../../src/infra/archive/control';
import type { ArchiveManifestImpact } from '../../../../src/core/archive/manifest-summary';
import { archiveConfirmationReply } from '../../../../src/handlers/commands/archive/presentation';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';

type Confirmation = Awaited<ReturnType<ArchiveControlService['requestConfirmation']>>;
const count = 1_000_000_000_000;
const impact = (insert = 0, update = 0, remove = 0, unknown = 0): ArchiveManifestImpact => ({
  insertOperations: insert * count,
  updateOperations: update * count,
  deleteOperations: remove * count,
  unknownImpactOperations: unknown * count,
});
const summary: Confirmation['summary'] = {
  status: 'available',
  totalOperations: 9 * count,
  impacts: impact(1, 2, 5, 1),
  targets: { distinctSources: 8 * count, unknownSourceOperations: count },
  categories: [
    { category: 'reset-progress', operations: count, ...impact(0, 1) },
    { category: 'remove-duplicate-progress', operations: count, ...impact(0, 0, 1) },
    { category: 'repair-message-time', operations: count, ...impact(0, 1) },
    { category: 'merge-duplicate-messages', operations: count, ...impact(0, 0, 1) },
    { category: 'exclude-by-policy', operations: 2 * count, ...impact(0, 0, 2) },
    { category: 'quarantine-data', operations: 2 * count, ...impact(1, 0, 1) },
    { category: 'unknown', operations: count, ...impact(0, 0, 0, 1) },
  ],
  recordTypes: [
    { collection: 'fetches', operations: 2 * count, ...impact(0, 1, 1) },
    { collection: 'messages', operations: 3 * count, ...impact(0, 1, 2) },
    { collection: 'archive_revisions', operations: count, ...impact(0, 0, 1) },
    { collection: 'archive_reactions', operations: count, ...impact(0, 0, 1) },
    { collection: 'archive_quarantine', operations: count, ...impact(1) },
    { collection: 'unknown', operations: count, ...impact(0, 0, 0, 1) },
  ],
};

describe('complete archive confirmation budget', () => {
  it.each(['en', 'zh-TW'] as const)(
    'retains every destructive record type and bound approval in %s',
    async (locale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      const guild = buildGuild({ id: '12345678901234567890', name: '*'.repeat(100) });
      const { bot } = buildFakeBot({
        translator,
        client: { guilds: { cache: new Map([[guild.id, guild]]) } },
      });
      for (const action of ['apply', 'resume', 'accept', 'rollback'] as const) {
        const confirmation: Confirmation = {
          token: 'abcdefghijklmnopqrstuvwx',
          action,
          expiresAt: 1_900_000_000_000,
          summary,
          run: {
            deletable: false,
            runId: 'r'.repeat(160),
            guildId: guild.id,
            status: action === 'apply' ? 'planned' : action === 'resume' ? 'partial' : 'complete',
            createdAt: 1_700_000_000_000,
            cutoff: 1_700_000_000_000,
            validUntil: 1_900_000_000_000,
            operations: 9 * count,
            unresolved: count,
            journalBytes: 999_999_999,
            issueCount: count,
            issueCategories: ['coverage'],
            actions: [action],
            scope: { policy: 'unavailable', historyDiscovery: 'unknown' },
          },
        };
        const reply = archiveConfirmationReply(confirmation, bot);
        const content = String(reply.content);
        expect(content.length, `${locale} ${action}`).toBeLessThanOrEqual(1900);
        for (const collection of [
          'fetches',
          'messages',
          'archive_revisions',
          'archive_reactions',
          'archive_quarantine',
          'unknown',
        ])
          expect(content).toContain(translator.t(`commands:archive_ui.collection_${collection}`));
        expect(content).not.toContain(confirmation.run.runId);
        expect(content).toContain('<t:1900000000:R>');
        expect(content).not.toMatch(/commands:|replies:|\{\{/);
        const components = JSON.stringify(reply.components);
        expect(components).not.toMatch(/archive\.manage_|archive\.more_actions/);
        expect(components).not.toContain('archive_actions');
        const controls = JSON.parse(components).flatMap(
          (row: { components: { type: number }[] }) => row.components,
        ) as { type: number }[];
        expect(controls.every((component) => component.type === 2)).toBe(true);
        expect(controls.length).toBeLessThanOrEqual(5);
        expect(components).toContain(translator.t('replies:archive.manage_back_plans'));
        expect(components).toContain('archive_confirm|abcdefghijklmnopqrstuvwx');
        if (action === 'accept') expect(content).toContain('72');
      }
    },
  );
});
