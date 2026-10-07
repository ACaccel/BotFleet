import { randomUUID } from 'node:crypto';
import {
  archiveJobDeletions,
  finalizeArchiveJobDeletion,
} from '../../../src/infra/archive/lifecycle';
import { type Client, type Channel, type APIEmbed } from 'discord.js';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultTranslator, type Translator } from '../../../src/core/i18n';
import type { ArchiveJob, ArchivePeriodicRun } from '../../../src/core/archive/types';
import { sanitizeArchiveProgress } from '../../../src/core/archive/progress';
import { createLogger } from '../../../src/core/logger';
import { ArchiveJobNotifier } from '../../../src/plugins/message-backup/runtime/job-notification';
import { ArchiveControlService } from '../../../src/infra/archive/control';
import { withFreshConnection } from '../helpers/mongo';
import { patchArchivePublicDetails } from '../../../src/infra/archive/public-message';

let translator: Translator;
beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
    fallbackLocale: 'zh-TW',
  });
});

const job = (): ArchiveJob => ({
  jobId: '1:request',
  requestId: 'request',
  guildId: '1',
  command: 'apply',
  options: {},
  status: 'complete',
  result: { counts: { inserted: 10 }, issues: [] },
  cancelRequested: false,
  createdAt: Date.now(),
  notification: { channelId: '10' },
});

const fixtures = () => {
  let message: { content: string; embeds: APIEmbed[]; components: unknown[] } = {
    content: '',
    embeds: [],
    components: [],
  };
  const send = vi.fn(
    async (payload: typeof message & { nonce?: string; enforceNonce?: boolean }) => {
      message = JSON.parse(JSON.stringify(payload)) as typeof message;
      return { id: '100' };
    },
  );
  const get = vi.fn(async () => message);
  const patch = vi.fn(async (_route: string, options: { body: Partial<typeof message> }) => {
    message = { ...message, ...options.body };
    return message;
  });
  const channel = { id: '10', isSendable: () => true, send } as unknown as Channel;
  const client = { rest: { get, patch } } as unknown as Client;
  const registry = {
    getChannel: () => channel,
    getRepos: () => undefined,
    getRole: () => undefined,
    listGuildIds: () => ['1'],
  };
  return {
    send,
    get,
    patch,
    client,
    registry,
    translator,
    current: () => message,
    logger: createLogger({ level: 'silent', pretty: false }),
  };
};

describe('durable archive job notifications', () => {
  it('keeps only shared navigation on the status embed across notifier restarts', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), command: 'plan' as const, runId: 'prepared-run' };
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(original);
      const sent = JSON.stringify(f.current());
      expect(sent).toContain('archive_panel|' + original.jobId);
      expect(sent).not.toContain('archive_confirm|');
      expect(sent).not.toContain('archive_panel|' + original.jobId + '|p|1');
      expect(sent).not.toContain('archive_panel|' + original.jobId + '|changes');
      expect(sent).not.toContain('archive_panel|' + original.jobId + '|technical');
      expect(f.current().content).toBe('');
      expect(f.current().embeds).toHaveLength(1);
      const saved = (await jobs.findOne({ jobId: original.jobId }))!;
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(saved);
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.patch).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.current())).toContain('archive_panel|' + original.jobId);
    }));

  it('omits invalid buttons and keeps legacy IDs out of the compact status embed', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), jobId: 'x'.repeat(160) };
      await connection.collection<ArchiveJob>('archive_jobs').insertOne(original);
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(original);
      expect(JSON.stringify(f.current().embeds)).not.toContain(original.jobId);
      expect(f.current().components).toEqual([]);
    }));

  it('replaces legacy button grids on heartbeat without losing the current status', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), status: 'running' as const, runId: 'run' };
      await connection.collection<ArchiveJob>('archive_jobs').insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      await f.patch('/synthetic', {
        body: {
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  custom_id: 'archive_panel|1:request|technical',
                  label: 'Technical',
                  style: 2,
                },
                { type: 2, custom_id: 'archive_manage|job|1:request', label: 'Manage', style: 2 },
              ],
            },
          ],
        },
      });
      await notifier.publish(original);
      const controls = JSON.stringify(f.current().components);
      expect(controls).not.toContain('technical');
      expect(controls).not.toContain('archive_manage|job|');
      expect(controls).toContain('archive_panel|1:request|cancel');
      expect(f.current().embeds).toHaveLength(1);
      expect(f.send).toHaveBeenCalledOnce();
    }));

  it('keeps active detail navigation and removes only the owning job cancellation control', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), status: 'running' as const };
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      const controls = [
        {
          type: 1,
          components: [
            { type: 2, custom_id: 'archive_manage|job|1:request', label: 'Manage', style: 2 },
            { type: 2, custom_id: 'archive_panel|1:request|cancel', label: 'Stop', style: 2 },
            { type: 2, custom_id: 'archive_panel|other-job|cancel', label: 'Other', style: 2 },
          ],
        },
      ];
      await f.patch('/synthetic', {
        body: {
          embeds: [...f.current().embeds, { description: 'Selected detail page' }],
          components: controls,
        },
      });
      await notifier.publish(original);
      expect(f.current().components).toEqual(controls);
      await jobs.updateOne({ jobId: original.jobId }, { $set: { status: 'complete' } });
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(original);
      expect(f.current().embeds[1]).toEqual({ description: 'Selected detail page' });
      const currentControls = JSON.stringify(f.current().components);
      expect(currentControls).toContain('archive_manage|job|1:request');
      expect(currentControls).toContain('archive_panel|other-job|cancel');
      expect(currentControls).not.toContain('archive_panel|1:request|cancel');
      expect(f.send).toHaveBeenCalledOnce();
    }));

  it('leaves detached navigation unchanged until its owning status is explicitly restored', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), status: 'running' as const };
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(original);
      await patchArchivePublicDetails(
        f.client,
        '10',
        '100',
        { content: 'Other job details', components: [] },
        { retainStatus: false },
      );
      await jobs.updateOne({ jobId: original.jobId }, { $set: { status: 'complete' } });
      const detached = structuredClone(f.current());
      const patches = f.patch.mock.calls.length;
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      expect(f.patch).toHaveBeenCalledTimes(patches);
      expect(f.current()).toEqual(detached);
      expect((await jobs.findOne({ jobId: original.jobId }))?.notification?.deliveredStatus).toBe(
        'running',
      );
      await notifier.publish(original, undefined, true, { restoreStatus: true });
      expect(f.current().embeds).toHaveLength(2);
      expect(f.current().embeds[1]).toEqual({ description: 'Other job details' });
      expect(JSON.stringify(f.current().embeds[0])).toContain(
        translator.t('replies:archive.view_state_complete'),
      );
      expect((await jobs.findOne({ jobId: original.jobId }))?.notification?.deliveredStatus).toBe(
        'complete',
      );
      expect(f.send).toHaveBeenCalledOnce();
    }));

  it('keeps two job notifications isolated when the first message browses the second job', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      type PublicMessage = { content: string; embeds: APIEmbed[]; components: unknown[] };
      const messages = new Map<string, PublicMessage>();
      const send = vi.fn(async (payload: PublicMessage) => {
        const id = String(100 + messages.size);
        messages.set(id, JSON.parse(JSON.stringify(payload)) as PublicMessage);
        return { id };
      });
      const get = vi.fn(async (route: string) => messages.get(route.split('/').at(-1)!));
      const patch = vi.fn(async (route: string, options: { body: Partial<PublicMessage> }) => {
        const id = route.split('/').at(-1)!;
        const message = { ...messages.get(id)!, ...options.body };
        messages.set(id, message);
        return message;
      });
      const client = { rest: { get, patch } } as unknown as Client;
      const registry = {
        ...f.registry,
        getChannel: () => ({ id: '10', isSendable: () => true, send }) as unknown as Channel,
      };
      const first = { ...job(), jobId: 'first-job', status: 'running' as const };
      const second = {
        ...job(),
        jobId: 'second-job',
        command: 'audit' as const,
        status: 'running' as const,
      };
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertMany([first, second]);
      const options = { ...f, client, registry, connection, guildId: '1' };
      const notifier = new ArchiveJobNotifier(options);
      await notifier.publish(first);
      await notifier.publish(second);
      await patchArchivePublicDetails(
        client,
        '10',
        '100',
        { content: 'Second job details inside the first message', components: [] },
        { retainStatus: false },
      );
      const detached = structuredClone(messages.get('100'));
      await jobs.updateMany({}, { $set: { status: 'complete' } });
      const restarted = new ArchiveJobNotifier(options);
      await restarted.publish(first);
      await restarted.publish(second);
      expect(messages.get('100')).toEqual(detached);
      expect(JSON.stringify(messages.get('101'))).toContain(
        translator.t('replies:archive.view_work_audit'),
      );
      expect(JSON.stringify(messages.get('101'))).toContain(
        translator.t('replies:archive.view_state_complete'),
      );
      expect((await jobs.findOne({ jobId: first.jobId }))?.notification?.deliveredStatus).toBe(
        'running',
      );
      expect((await jobs.findOne({ jobId: second.jobId }))?.notification?.deliveredStatus).toBe(
        'complete',
      );
      expect(send).toHaveBeenCalledTimes(2);
    }));

  it('reuses a durable daily scan message after restart and replaces a deleted message', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const runs = connection.collection<ArchivePeriodicRun>('archive_periodic_runs');
      await runs.insertOne({
        _id: 'current',
        runId: 'periodic:synthetic',
        status: 'running',
        cutoff: Date.now(),
        full: true,
      });
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publishScan(
        'periodic:synthetic',
      );
      expect((await runs.findOne({ _id: 'current' }))?.notification?.messageId).toBe('100');
      expect(JSON.stringify(f.current())).toContain('archive_panel|scan|periodic:synthetic');
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publishScan(
        'periodic:synthetic',
      );
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.patch).toHaveBeenCalledTimes(1);
      f.get.mockRejectedValueOnce({ code: 10008 });
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publishScan(
        'periodic:synthetic',
      );
      expect(f.send).toHaveBeenCalledTimes(2);
    }));

  it('retains terminal daily scan status and persists retry metadata after delivery failure', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const runs = connection.collection<ArchivePeriodicRun>('archive_periodic_runs');
      await runs.insertOne({
        _id: 'current',
        runId: 'periodic:synthetic',
        status: 'partial',
        cutoff: Date.now(),
        full: true,
        notification: { channelId: '10', messageId: '100' },
      });
      f.patch.mockRejectedValueOnce(new Error('Discord unavailable'));
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publishScan(
        'periodic:synthetic',
      );
      const saved = await runs.findOne({ _id: 'current' });
      expect(saved?.status).toBe('partial');
      expect(saved?.notification?.nextAttemptAt).toBeGreaterThan(Date.now());
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publishScan(
        'periodic:synthetic',
      );
      expect((await runs.findOne({ _id: 'current' }))?.notification).toMatchObject({
        messageId: '100',
        deliveredStatus: 'partial',
      });
      expect(f.send).not.toHaveBeenCalled();
    }));

  it('rereads the saved reference during concurrent publications with stale job objects', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      const original = job();
      await jobs.insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await Promise.all([notifier.publish(original), notifier.publish(original)]);
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.patch).toHaveBeenCalledOnce();
      const saved = (await jobs.findOne({ jobId: original.jobId }))!;
      expect(saved.notification).toMatchObject({ messageId: '100', deliveredStatus: 'complete' });
      expect(f.current().content).toBe('');
      expect(f.patch.mock.calls[0]?.[1].body).toMatchObject({ allowed_mentions: { parse: [] } });
    }));

  it('deduplicates an ambiguous initial send retry with the same durable nonce', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = job();
      await connection.collection<ArchiveJob>('archive_jobs').insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      f.send.mockRejectedValueOnce(new Error('response acknowledgement unavailable'));
      await notifier.publish(original);
      await notifier.publish(original);
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(f.send.mock.calls[0]?.[0]).toMatchObject({
        nonce: expect.stringMatching(/^[a-f0-9]{24}$/),
        enforceNonce: true,
      });
      expect(f.send.mock.calls[1]?.[0].nonce).toBe(f.send.mock.calls[0]?.[0].nonce);
      expect(f.send.mock.calls[1]?.[0].enforceNonce).toBe(true);
    }));

  it('aligns a stopped periodic snapshot with durable terminal status and corrects stale restart state', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const runs = connection.collection<ArchivePeriodicRun>('archive_periodic_runs');
      const paused = sanitizeArchiveProgress({
        work: 'periodic',
        scanId: 'periodic:stopped',
        state: 'paused',
        phase: 'history',
        reason: 'capacity',
      })!;
      await runs.insertOne({
        _id: 'current',
        runId: 'periodic:stopped',
        cutoff: Date.now(),
        full: true,
        status: 'partial',
        progress: paused,
      });
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publishScan('periodic:stopped');
      expect(JSON.stringify(f.current().embeds)).toContain(
        translator.t('replies:archive.view_state_partial'),
      );
      expect(JSON.stringify(f.current().embeds)).toContain(
        translator.t('replies:archive.view_public_scan_stopped'),
      );
      expect(JSON.stringify(f.current().embeds)).not.toContain(
        translator.t('replies:archive.view_state_paused'),
      );
      await runs.updateOne(
        { _id: 'current' },
        { $set: { status: 'running', 'progress.state': 'partial' } },
      );
      await notifier.publishScan('periodic:stopped');
      expect(JSON.stringify(f.current().embeds)).toContain(
        translator.t('replies:archive.view_state_running'),
      );
      expect(JSON.stringify(f.current().embeds)).not.toContain(
        translator.t('replies:archive.view_public_scan_stopped'),
      );
      expect(f.send).toHaveBeenCalledOnce();
    }));

  it.each(['get', 'patch'] as const)(
    'does not duplicate a notification when its %s fails without a missing-message response',
    async (operation) =>
      withFreshConnection(async (connection) => {
        const f = fixtures();
        const original = job();
        original.notification!.messageId = '100';
        const jobs = connection.collection<ArchiveJob>('archive_jobs');
        await jobs.insertOne(original);
        f[operation].mockRejectedValueOnce(new Error('forbidden'));
        await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(original);
        const saved = (await jobs.findOne({ jobId: original.jobId }))!;
        expect(saved).toMatchObject({ status: 'complete', result: original.result });
        expect(saved.notification?.nextAttemptAt).toBeGreaterThan(Date.now());
        expect(saved.notification?.deliveredStatus).toBeUndefined();
        expect(f.send).not.toHaveBeenCalled();
      }),
  );

  it('replaces a deleted message but does not redirect a job to an unrelated channel', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = job();
      original.notification!.messageId = '99';
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      f.patch.mockRejectedValueOnce({ code: 10008 });
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      expect(f.send).toHaveBeenCalledTimes(1);
      await jobs.updateOne({ jobId: original.jobId }, { $set: { 'notification.channelId': '11' } });
      await notifier.publish(original);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.patch).toHaveBeenCalledTimes(1);
    }));

  it('suppresses already queued predecessor publications after ownership changes inside the message lock', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = job();
      original.notification!.messageId = '100';
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      let reads = 0;
      const find = jobs.findOne.bind(jobs);
      vi.spyOn(jobs, 'findOne').mockImplementation(async (...args) => {
        reads += 1;
        if (reads === 2)
          await jobs.updateOne(
            { jobId: original.jobId },
            { $set: { 'notification.supersededAt': Date.now() } },
          );
        return find(...args);
      });
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(original);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.patch).not.toHaveBeenCalled();
    }));

  it('hands the original public card from plan to confirmed apply and verification without reclaiming it on replay', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const runId = 'synthetic-run';
      const actor = { userId: '456', channelId: '10' };
      await connection.collection('archive_repair_runs').insertOne({
        _id: runId,
        guildId: '1',
        status: 'planned',
        schemaHash: 'archive-v2',
        policyHash: 'synthetic-policy',
        createdAt: Date.now(),
        validUntil: Date.now() + 60000,
        operations: 0,
        unresolved: 0,
        journalBytes: 100,
        issues: [],
      } as never);
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      const plan = { ...job(), command: 'plan' as const, runId };
      await jobs.insertOne(plan);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(plan);
      const control = new ArchiveControlService(connection, '1');
      const confirmation = await control.requestConfirmation('apply', runId, actor);
      const reference = { channelId: '10', messageId: '100' };
      const applied = await control.confirm(confirmation.token, actor, reference);
      expect((await jobs.findOne({ jobId: plan.jobId }))?.notification?.supersededAt).toBeTypeOf(
        'number',
      );
      await notifier.publish((await jobs.findOne({ jobId: applied.jobId }))!);
      expect(f.send).toHaveBeenCalledOnce();
      const replay = await control.confirm(confirmation.token, actor, reference);
      expect(replay.jobId).toBe(applied.jobId);
      expect(await jobs.countDocuments({ guildId: '1' })).toBe(2);
      const verified = await control.submit('verify', { runId, notification: reference });
      const current = (await jobs.findOne({ jobId: verified.jobId }))!;
      await notifier.publish(current);
      const edits = f.patch.mock.calls.length;
      await control.confirm(confirmation.token, actor, reference);
      await notifier.publish(plan);
      await notifier.publish((await jobs.findOne({ jobId: applied.jobId }))!);
      expect(f.patch).toHaveBeenCalledTimes(edits);
      expect(f.send).toHaveBeenCalledOnce();
      expect(
        (await jobs.findOne({ jobId: verified.jobId }))?.notification?.supersededAt,
      ).toBeUndefined();
    }));
  it('freezes a deleted public card and ignores every late heartbeat', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = job();
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      expect(JSON.stringify(f.current())).toContain('archive_panel|1:request');
      const control = new ArchiveControlService(connection, '1');
      expect(await control.deleteJob(original.jobId)).toMatchObject({ deleted: true });
      await notifier.publishDeleted(original.jobId);
      expect(f.current().components).toEqual([]);
      expect(f.current().embeds).toEqual([
        { description: translator.t('replies:archive.deleted_public') },
      ]);
      const patches = f.patch.mock.calls.length;
      await notifier.publish(original);
      await notifier.publishDeleted(original.jobId);
      expect(f.patch).toHaveBeenCalledTimes(patches);
      expect(f.send).toHaveBeenCalledOnce();
    }));

  it('does not overwrite another panel when deleting the former message owner', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = job();
      await connection.collection<ArchiveJob>('archive_jobs').insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      await patchArchivePublicDetails(
        f.client,
        '10',
        '100',
        { content: 'Another job panel', components: [] },
        { retainStatus: false },
      );
      const detached = structuredClone(f.current());
      const patches = f.patch.mock.calls.length;
      const control = new ArchiveControlService(connection, '1');
      expect(await control.deleteJob(original.jobId)).toMatchObject({ deleted: true });
      await notifier.publishDeleted(original.jobId);
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publishDeleted(
        original.jobId,
      );
      expect(f.current()).toEqual(detached);
      expect(f.patch).toHaveBeenCalledTimes(patches);
      expect(f.send).toHaveBeenCalledOnce();
      const receipt = await archiveJobDeletions(connection).findOne({
        _id: 'job:' + original.jobId,
      });
      expect(receipt?.notification?.supersededAt).toBeTypeOf('number');
      expect(receipt?.notifiedAt).toBeTypeOf('number');
    }));

  it('shows pending deletion without controls and retries an interrupted deleted-card update', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), status: 'running' as const };
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      const control = new ArchiveControlService(connection, '1');
      await control.deleteJob(original.jobId);
      await notifier.publish(original);
      expect(JSON.stringify(f.current())).toContain(
        translator.t('replies:archive.deletion_pending_public'),
      );
      expect(f.current().components).toEqual([]);
      await jobs.updateOne({ jobId: original.jobId }, { $set: { status: 'cancelled' } });
      await finalizeArchiveJobDeletion(connection, '1', original.jobId);
      f.patch.mockRejectedValueOnce(new Error('temporary Discord outage'));
      await notifier.publishDeleted(original.jobId);
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publishDeleted(
        original.jobId,
      );
      expect(f.current().embeds).toEqual([
        { description: translator.t('replies:archive.deleted_public') },
      ]);
    }));
  it('keeps active manifest management and stop controls within Discord row limits', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), status: 'running' as const, runId: 'run' };
      await connection.collection<ArchiveJob>('archive_jobs').insertOne(original);
      await new ArchiveJobNotifier({ ...f, connection, guildId: '1' }).publish(original);
      const components = f.current().components as { components: unknown[] }[];
      expect(components.map((row) => row.components.length)).toEqual([2]);
      expect(JSON.stringify(components)).toContain('archive_panel|1:request');
      expect(JSON.stringify(components)).not.toContain('|technical');
      expect(JSON.stringify(components)).toContain('archive_panel|1:request|cancel');
    }));
  it.each(['bulk-confirm', 'bulk-result'] as const)(
    'preserves a bound %s card during both heartbeat and deleted-job publication',
    async (marker) =>
      withFreshConnection(async (connection) => {
        const f = fixtures();
        const original = { ...job(), status: 'running' as const };
        const jobs = connection.collection<ArchiveJob>('archive_jobs');
        await jobs.insertOne(original);
        const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
        await notifier.publish(original);
        const reviewId = randomUUID();
        await connection.collection('archive_bulk_deletions').insertOne({
          _id: reviewId,
          guildId: '1',
          actor: { channelId: '10', messageId: '100' },
          state: marker === 'bulk-confirm' ? 'running' : 'complete',
        } as never);
        const components = [
          {
            type: 1,
            components: [
              {
                type: 2,
                custom_id: 'archive_manage|' + marker + '|' + reviewId,
                label: 'Bulk cleanup',
                style: 2,
              },
            ],
          },
        ];
        await f.patch('/synthetic', {
          body: { content: 'Bulk cleanup progress', embeds: [], components },
        });
        const patches = f.patch.mock.calls.length;
        await new ArchiveControlService(connection, '1').deleteJob(original.jobId);
        await notifier.publish(original);
        expect(f.patch).toHaveBeenCalledTimes(patches);
        await jobs.updateOne({ jobId: original.jobId }, { $set: { status: 'cancelled' } });
        await finalizeArchiveJobDeletion(connection, '1', original.jobId);
        await notifier.publishDeleted(original.jobId);
        expect(f.patch).toHaveBeenCalledTimes(patches);
        expect(f.current().content).toBe('Bulk cleanup progress');
        expect(f.current().components).toEqual(components);
      }),
  );

  it('does not create or recreate a public notice for deletion-requested jobs', async () =>
    withFreshConnection(async (connection) => {
      const f = fixtures();
      const original = { ...job(), status: 'running' as const, deleteRequestedAt: Date.now() };
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne(original);
      const notifier = new ArchiveJobNotifier({ ...f, connection, guildId: '1' });
      await notifier.publish(original);
      expect(f.send).not.toHaveBeenCalled();
      await jobs.updateOne(
        { jobId: original.jobId },
        { $set: { 'notification.messageId': '100' } },
      );
      f.get.mockRejectedValueOnce(Object.assign(new Error('removed'), { code: 10008 }));
      await notifier.publish(original);
      expect(f.send).not.toHaveBeenCalled();
    }));
});
