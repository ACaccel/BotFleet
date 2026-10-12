/**
 * Unit coverage for the handler-boundary error helper.
 *
 * The helper routes a caught error down two independent channels:
 *   - operator channel: a structured log line, always written;
 *   - user channel: a localised reply that is taxonomy-driven for a
 *     `DomainError` (its `messageKey`) and falls back to the command's
 *     `replies:<feature>.failed` copy (with a `traceId`) otherwise.
 */
import { describe, expect, it } from 'vitest';

import { DatabaseError } from '../../../src/core/errors';
import type { Translator } from '../../../src/core/i18n';
import { replyForError, resolveErrorReply } from '../../../src/infra/discord/reply-for-error';

/**
 * A translator stub that returns a `T(<key>)` marker (plus a JSON of
 * params) for every key. The `T(...)` wrapper means a successful
 * resolution is always distinguishable from the bare key — mirroring
 * real i18next, which returns the key verbatim only on a catalog miss.
 */
const stubTranslator = (): Translator =>
  ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? `T(${key})` : `T(${key})|${JSON.stringify(params)}`,
    tStrict: (key: string) => `T(${key})`,
  }) as unknown as Translator;

/** A translator stub whose `t` always misses (echoes the key back). */
const missTranslator = (): Translator =>
  ({
    t: (key: string) => key,
    tStrict: (key: string) => key,
  }) as unknown as Translator;

/**
 * A logger stub recording every `error` / `info` call. The helpers
 * now rely on the ambient `bot` base binding (created via
 * `createBootstrapLogger`) rather than re-`child({ bot })`-ing on every
 * call, so the outer logger must expose `info` directly for `logSystem`
 * and `child(...)` for `logError`'s `guildId` scope.
 */
const stubLogger = () => {
  const errorCalls: unknown[] = [];
  const infoCalls: unknown[] = [];
  const child = {
    error: (obj: unknown) => errorCalls.push(obj),
    info: (obj: unknown) => infoCalls.push(obj),
    child: () => child,
  };
  const logger = {
    error: (obj: unknown) => errorCalls.push(obj),
    info: (obj: unknown) => infoCalls.push(obj),
    child: () => child,
  };
  return { logger: logger as never, errorCalls, infoCalls };
};

/** A minimal interaction fake capturing reply / editReply payloads. */
const stubInteraction = (state: { deferred: boolean; replied: boolean }) => {
  const replies: Array<{ content?: string }> = [];
  const editReplies: Array<{ content?: string }> = [];
  const followUps: Array<{ content?: string; flags?: number }> = [];
  const deleted: string[] = [];
  return {
    interaction: {
      get deferred() {
        return state.deferred;
      },
      get replied() {
        return state.replied;
      },
      reply: async (opts: { content?: string }) => {
        replies.push(opts);
      },
      editReply: async (opts: { content?: string }) => {
        editReplies.push(opts);
      },
      deleteReply: async () => {
        deleted.push('@original');
      },
      followUp: async (opts: { content?: string; flags?: number }) => {
        followUps.push(opts);
      },
    } as never,
    replies,
    editReplies,
    followUps,
    deleted,
  };
};

describe('resolveErrorReply — channel selection', () => {
  it('uses the DomainError messageKey + messageParams for a DomainError', () => {
    const error = new DatabaseError({
      code: 'DATABASE_DUPLICATE_KEY',
      messageKey: 'errors:db.duplicate_key',
      context: { operation: 'ReplyRepo.create' },
      messageParams: { keyword: 'hi' },
    });
    const text = resolveErrorReply(stubTranslator(), error, 'replies:add_reply.failed', 'abc123');
    expect(text).toBe('T(errors:db.duplicate_key)|{"keyword":"hi"}');
  });

  it('falls back to the per-feature failed key + traceId for a non-DomainError', () => {
    const text = resolveErrorReply(
      stubTranslator(),
      new Error('raw mongoose blow-up'),
      'replies:add_reply.failed',
      'abc123',
    );
    expect(text).toBe('T(replies:add_reply.failed)|{"traceId":"abc123"}');
  });

  it('treats a plain thrown value (non-Error) as a non-DomainError fallback', () => {
    const text = resolveErrorReply(stubTranslator(), 'oops', 'replies:help.failed', 'zzz999');
    expect(text).toBe('T(replies:help.failed)|{"traceId":"zzz999"}');
  });

  it('returns an empty string when the translator is unbound', () => {
    expect(resolveErrorReply(undefined, new Error('x'), 'replies:help.failed', 'id')).toBe('');
  });

  it('degrades to the per-feature fallback when a DomainError messageKey has no catalog entry', () => {
    // i18next echoes the key on a miss; the helper must not surface a
    // raw `errors:*` key and instead use the toned fallback copy.
    const error = new DatabaseError({
      code: 'DATABASE_DUPLICATE_KEY',
      messageKey: 'errors:db.nonexistent_key',
      context: { operation: 'ReplyRepo.create' },
    });
    const text = resolveErrorReply(missTranslator(), error, 'replies:add_reply.failed', 'tr4ce1');
    // missTranslator echoes every key, so the fallback also echoes —
    // the assertion confirms the fallback *key* (not the error key)
    // was the one looked up.
    expect(text).toBe('replies:add_reply.failed');
  });
});

describe('replyForError — dual-channel boundary', () => {
  it('logs the operator channel and replies with the messageKey for a DomainError', async () => {
    const { logger, errorCalls } = stubLogger();
    const { interaction, editReplies } = stubInteraction({ deferred: true, replied: false });
    const error = new DatabaseError({
      code: 'DATABASE_DUPLICATE_KEY',
      messageKey: 'errors:db.duplicate_key',
      context: { operation: 'ReplyRepo.create' },
    });

    await replyForError(
      interaction,
      { logger, translator: stubTranslator() },
      error,
      'replies:add_reply.failed',
      'g-1',
    );

    // Operator channel always fires with the full error.
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]).toMatchObject({ err: error });
    // User channel: taxonomy-driven messageKey (deferred -> editReply).
    expect(editReplies).toEqual([{ content: 'T(errors:db.duplicate_key)' }]);
  });

  it('logs the operator channel and replies with the per-feature fallback for a raw error', async () => {
    const { logger, errorCalls } = stubLogger();
    const { interaction, editReplies } = stubInteraction({ deferred: true, replied: false });
    const raw = new Error('connection reset by peer');

    await replyForError(
      interaction,
      { logger, translator: stubTranslator() },
      raw,
      'replies:add_reply.failed',
      'g-1',
    );

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]).toMatchObject({ err: raw });
    // User channel: fallback key carrying a generated 6-char traceId.
    expect(editReplies).toHaveLength(1);
    const content = editReplies[0]?.content ?? '';
    expect(content).toMatch(/^T\(replies:add_reply\.failed\)\|\{"traceId":"[0-9a-z]{6}"\}$/);
  });

  it('replies (ephemeral) rather than edits when the interaction is not acknowledged', async () => {
    const { logger } = stubLogger();
    const { interaction, replies, editReplies } = stubInteraction({
      deferred: false,
      replied: false,
    });

    await replyForError(
      interaction,
      { logger, translator: stubTranslator() },
      new Error('boom'),
      'replies:help.failed',
    );

    expect(editReplies).toHaveLength(0);
    expect(replies).toHaveLength(1);
  });

  it('replaces a public reply with an ephemeral follow-up when asked', async () => {
    const { logger } = stubLogger();
    const { interaction, editReplies, followUps, deleted } = stubInteraction({
      deferred: true,
      replied: false,
    });

    await replyForError(
      interaction,
      { logger, translator: stubTranslator() },
      new Error('boom'),
      'replies:help.failed',
      'g1',
      { privateAfterPublicReply: true },
    );

    expect(editReplies).toHaveLength(0);
    expect(deleted).toEqual(['@original']);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.flags).toBe(64);
    expect(followUps[0]?.content).toContain('T(replies:help.failed)');
  });

  it('still logs the operator channel when the translator is unbound', async () => {
    const { logger, errorCalls } = stubLogger();
    const { interaction, replies, editReplies } = stubInteraction({
      deferred: true,
      replied: false,
    });

    await replyForError(
      interaction,
      { logger, translator: undefined },
      new Error('boom'),
      'replies:help.failed',
    );

    expect(errorCalls).toHaveLength(1);
    // Empty resolved content -> no user-facing reply attempted.
    expect(replies).toHaveLength(0);
    expect(editReplies).toHaveLength(0);
  });

  it('does not throw when the interaction errors are unrelated', async () => {
    // A non-expired Discord error must propagate, but a generic stub
    // here simply verifies the happy path does not swallow real bugs.
    const { logger } = stubLogger();
    const { interaction } = stubInteraction({ deferred: true, replied: false });
    await expect(
      replyForError(
        interaction,
        { logger, translator: stubTranslator() },
        new Error('boom'),
        'replies:help.failed',
      ),
    ).resolves.toBeUndefined();
  });
});
