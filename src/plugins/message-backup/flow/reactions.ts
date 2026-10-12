import { Routes } from 'discord.js';

import type { ArchiveRest } from './rest-discovery';
import { mapArchiveChannels } from './scheduler';
import { ArchivePipelineBudget } from './pipeline';
import { ARCHIVE_LIMITS } from '../../../core/archive/limits';

type ReactionKind = 'normal' | 'burst';
interface ReactionStream {
  emoji: string;
  kinds: readonly ReactionKind[];
  /** Only fresh source evidence that is still current may prove emptiness. */
  emptyKinds?: readonly ReactionKind[];
}
interface ReactionPage {
  emoji: string;
  kind: ReactionKind;
  page: number;
  userIds: string[];
}
interface ReactionResult {
  emoji: string;
  kind: ReactionKind;
  users: number;
  complete: boolean;
  reason?: string;
  /** The thrown value behind an incomplete stream, kept for failure classification. */
  error?: unknown;
}
interface ReactionFetchOptions {
  rest: ArchiveRest;
  channelId: string;
  messageId: string;
  streams: readonly ReactionStream[];
  stage(page: ReactionPage): Promise<void>;
  request?<T>(key: string, operation: () => Promise<T>): Promise<T>;
  /** False once the message may have changed since its evidence was read; the fetch aborts. */
  isCurrent(): boolean;
  /** Distinguishes request identities across evidence reads that must not share pages. */
  evidenceScope?: string;
  signal?: AbortSignal;
  concurrency?: number;
  pipelineBudget?: ArchivePipelineBudget;
}

/**
 * A reaction refresh could not publish a complete generation. `reasons` lists each
 * incomplete stream; `cause` is the first Discord API error behind them (or the
 * first thrown value), so failure classification can see its code and status.
 */
export class ArchiveReactionRefreshError extends Error {
  public readonly reasons: readonly string[];

  public constructor(
    message: string,
    results: readonly Pick<ReactionResult, 'complete' | 'reason' | 'error'>[],
  ) {
    const failed = results.filter((result) => !result.complete);
    const errors = failed.map((result) => result.error).filter((error) => error !== undefined);
    const discord = errors.find((error) => {
      const { code, status } = (typeof error === 'object' && error !== null ? error : {}) as {
        code?: unknown;
        status?: unknown;
      };
      return typeof code === 'number' || typeof status === 'number';
    });
    super(message, { cause: discord ?? errors[0] });
    this.name = 'ArchiveReactionRefreshError';
    this.reasons = failed.map((result) => result.reason ?? 'incomplete');
  }
}

/** Pages are staged, never published as a complete generation until the caller validates every stream. */
export async function fetchReactionMemberships(
  options: ReactionFetchOptions,
): Promise<ReactionResult[]> {
  const scope = options.evidenceScope ?? '';
  const cancelled = (): boolean => options.signal?.aborted === true;
  const pipeline = options.pipelineBudget ?? new ArchivePipelineBudget();
  const work = options.streams.flatMap((stream) => stream.kinds.map((kind) => ({ stream, kind })));
  const results = await mapArchiveChannels(
    work,
    async ({ stream, kind }): Promise<ReactionResult> => {
      let after: string | undefined;
      let count = 0;
      let page = 0;
      try {
        if (cancelled()) throw new Error('reaction-fetch-cancelled');
        if (!options.isCurrent()) throw new Error('reaction-changed-during-fetch');
        if (stream.emptyKinds?.includes(kind))
          return { emoji: stream.emoji, kind, users: 0, complete: true };
        for (;;) {
          if (cancelled()) throw new Error('reaction-fetch-cancelled');
          if (!options.isCurrent()) throw new Error('reaction-changed-during-fetch');
          const release = await pipeline.reserve(
            ARCHIVE_LIMITS.reactionPageBytes,
            options.signal,
            'reactions',
          );
          let reserved = ARCHIVE_LIMITS.reactionPageBytes;
          const started = Date.now();
          let bytes = 0;
          try {
            const query = new URLSearchParams({
              limit: '100',
              type: kind === 'normal' ? '0' : '1',
            });
            if (after !== undefined) query.set('after', after);
            const read = async (): Promise<unknown> => {
              if (cancelled()) throw new Error('reaction-fetch-cancelled');
              return options.rest.get(
                Routes.channelMessageReaction(
                  options.channelId,
                  options.messageId,
                  encodeURIComponent(stream.emoji),
                ),
                { query, ...(options.signal === undefined ? {} : { signal: options.signal }) },
              );
            };
            let raw =
              options.request === undefined
                ? await read()
                : await options.request(
                    `reaction:${options.channelId}:${options.messageId}:${stream.emoji}:${kind}:${after ?? ''}:${scope}`,
                    read,
                  );
            if (cancelled()) throw new Error('reaction-fetch-cancelled');
            if (!options.isCurrent()) throw new Error('reaction-changed-during-fetch');
            if (!Array.isArray(raw) || raw.length > 100) throw new Error('invalid-reaction-page');
            const pageLength = raw.length;
            bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
            if (bytes > ARCHIVE_LIMITS.batchBytes) throw new Error('reaction-page-too-large');
            if (bytes > reserved) {
              await release.grow(bytes, options.signal);
              reserved = bytes;
            }
            // Retain only IDs, never the full user payload, across a storage await.
            const ids = [
              ...new Set(
                raw.map((item: unknown) => {
                  const id = (item as { id?: unknown }).id;
                  if (typeof id !== 'string' || !/^\d+$/.test(id))
                    throw new Error('invalid-reaction-user-id');
                  return id;
                }),
              ),
            ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
            raw = undefined;
            const fresh =
              after === undefined ? ids : ids.filter((id) => BigInt(id) > BigInt(after!));
            if (pageLength > 0 && fresh.length === 0) throw new Error('reaction-cursor-stalled');
            // User profiles are no longer retained, so staging holds only bounded ID arrays.
            release.shrink(
              Math.min(reserved, Math.max(1, Buffer.byteLength(JSON.stringify(fresh), 'utf8') * 2)),
            );
            if (fresh.length > 0) {
              if (cancelled() || !options.isCurrent())
                throw new Error('reaction-changed-during-fetch');
              await options.stage({ emoji: stream.emoji, kind, page, userIds: fresh });
              page += 1;
              count += fresh.length;
              after = fresh[fresh.length - 1];
            }
            if (pageLength < 100) break;
          } finally {
            pipeline.record('reactions', Date.now() - started, bytes);
            release();
          }
        }
        return { emoji: stream.emoji, kind, users: count, complete: true };
      } catch (error) {
        return {
          emoji: stream.emoji,
          kind,
          users: count,
          complete: false,
          reason: String(error),
          error,
        };
      }
    },
    options.concurrency ?? 1,
  );
  if (!options.isCurrent() || cancelled()) {
    for (const result of results) {
      result.complete = false;
      result.reason = 'reaction-changed-during-fetch';
    }
  }
  return results;
}
