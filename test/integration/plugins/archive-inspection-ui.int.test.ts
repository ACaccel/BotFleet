import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveControlService } from '../../../src/infra/archive/control';
import { createDefaultTranslator } from '../../../src/core/i18n';
import { archiveManifestReply } from '../../../src/handlers/commands/archive/presentation';
import { publishArchiveReply } from '../../../src/handlers/commands/archive/replies';
import { resolveArchiveNavigation } from '../../../src/handlers/commands/archive/navigation';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';
import { withFreshConnection } from '../helpers/mongo';

const runId = '12345678-1234-4234-8234-123456789abc';
const guildId = '123456789012345678';
const actor = { userId: '223456789012345678', channelId: '323456789012345678' };

describe('persisted archive inspection presentation', () => {
  it.each(['en', 'zh-TW'] as const)(
    'shows persisted source identities without exposing recovery images or sending extra %s messages',
    async (locale) =>
      withFreshConnection(async (connection) => {
        const changes = Array.from({ length: 14 }, (_, sequence) => {
          const before = {
            _id: (sequence + 1).toString(16).padStart(24, '0'),
            channelID: String(423456789012345678n + BigInt(sequence % 12)),
            channel: `stored-source-${sequence % 12}`,
            lastMessageID: '523456789012345678',
            content: 'PRIVATE_RECOVERY_BODY',
            attachments: [{ url: 'https://example.invalid/PRIVATE_SIGNED_URL' }],
          };
          return {
            _id: `operation-${sequence}`,
            runId,
            sequence,
            collection: 'fetches',
            documentId: before._id,
            state: 'planned',
            reason:
              sequence < 12 ? 'reset-cursor-for-full-reconciliation' : 'delete-duplicate-cursor',
            before,
            after: sequence < 12 ? { ...before, lastMessageID: '' } : null,
            dependencies: sequence < 12 ? [] : [`operation-${sequence % 12}`],
            beforeHash: 'a'.repeat(64),
            afterHash: 'b'.repeat(64),
          };
        });
        await connection.collection('archive_repair_runs').insertOne({
          _id: runId,
          guildId,
          status: 'planned',
          schemaHash: 'archive-v2',
          policyHash: 'synthetic-policy',
          createdAt: 1_700_000_000_000,
          cutoff: 1_700_000_000_000,
          validUntil: Date.now() + 60_000,
          operations: changes.length,
          unresolved: 0,
          journalBytes: 1000,
          issues: [],
        } as never);
        await connection.collection('archive_repair_operations').insertMany(changes as never);
        const translator = await createDefaultTranslator({
          localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
          fallbackLocale: locale,
        });
        const { bot } = buildFakeBot({ translator });
        const control = new ArchiveControlService(connection, guildId);
        const reply = await archiveManifestReply(runId, bot, control, actor, { view: 'changes' });
        const content = String(reply.content);
        expect(content.length).toBeLessThanOrEqual(1900);
        expect(content.replace(/\\/g, '')).not.toContain('stored-source-');
        expect(content).toContain('12');
        expect(content).not.toMatch(/PRIVATE_|```|commands:|replies:|\{\{/);
        const components = JSON.parse(JSON.stringify(reply.components)) as {
          components: { custom_id: string }[];
        }[];
        const ids = components.flatMap((row) => row.components.map((entry) => entry.custom_id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id.length <= 100)).toBe(true);
        expect(ids.length).toBeLessThanOrEqual(3);
        expect(content).toContain('423456789012345678');
        expect(content).toContain(translator.t('commands:archive_ui.collection_fetches'));
        expect(content).not.toContain('523456789012345678');
        expect(content).not.toContain('000000000000000000000001');
        expect(content).not.toContain('a'.repeat(64));
        expect(content).not.toContain('b'.repeat(64));
        expect(reply.files).toBeUndefined();
        const sink = newInteractionSink();
        const interaction = buildChatInputInteraction({ guildId, sink });
        await publishArchiveReply(interaction, reply);
        expect(sink.editReplies).toHaveLength(1);
        expect(sink.followUps).toHaveLength(0);
        expect(sink.replies).toHaveLength(0);
        expect(JSON.stringify(sink.editReplies)).not.toContain('PRIVATE_');
        const navigationActor = { ...actor, guildId };
        for (const id of ids) {
          const position = resolveArchiveNavigation(id, navigationActor).page;
          expect(['summary', 'changes']).toContain(position.view);
          expect(position.group).toBeUndefined();
          expect(position.sourceId).toBeUndefined();
          expect(position.sequence).toBeUndefined();
        }
        const small = await archiveManifestReply(runId, bot, control, actor, {
          view: 'changes',
          category: 'remove-duplicate-progress',
        });
        const smallContent = String(small.content);
        expect(smallContent.length).toBeLessThanOrEqual(1900);
        for (const sourceId of ['423456789012345678', '423456789012345679'])
          expect(smallContent).toContain(sourceId);
        expect(smallContent).toContain(
          translator.t('commands:archive_ui.effect_remove-duplicate-progress'),
        );
        expect(smallContent).toContain(translator.t('commands:archive_ui.collection_fetches'));
        expect(smallContent).not.toMatch(
          /PRIVATE_|stored-source-|operation-\d|```|commands:|replies:|\{\{/,
        );
        expect(smallContent).not.toContain('523456789012345678');
        expect(smallContent).not.toContain('000000000000000000000001');
        expect(smallContent).not.toContain('a'.repeat(64));
        expect(smallContent).not.toContain('b'.repeat(64));
        expect(small.files).toBeUndefined();
        const smallControls = (
          JSON.parse(JSON.stringify(small.components)) as {
            components: { custom_id: string }[];
          }[]
        ).flatMap((row) => row.components);
        expect(smallControls.length).toBeLessThanOrEqual(3);
        expect(smallControls.every((entry) => entry.custom_id.startsWith('archive_browse|'))).toBe(
          true,
        );
        for (const entry of smallControls) {
          const position = resolveArchiveNavigation(entry.custom_id, navigationActor).page;
          expect(['summary', 'changes']).toContain(position.view);
          expect(position.sequence).toBeUndefined();
          expect(position.returnTo).toBeUndefined();
        }
        await publishArchiveReply(interaction, small);
        expect(sink.editReplies).toHaveLength(2);
        expect(sink.followUps).toHaveLength(0);
        expect(sink.replies).toHaveLength(0);
        expect(JSON.stringify(sink.editReplies)).not.toMatch(
          /PRIVATE_|operation-\d|beforeHash|afterHash/,
        );
      }),
  );
});
