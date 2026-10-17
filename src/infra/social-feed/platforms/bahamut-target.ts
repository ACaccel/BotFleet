import { FeedError } from '../../../core/errors';
import { err, ok, type Result } from '../../../core/result';
import { FEED_PLATFORM_DISPLAY_NAMES, type FeedFailure } from '../types';

export type BahamutTarget =
  | { readonly kind: 'board'; readonly board: string; readonly subboard?: string }
  | { readonly kind: 'thread'; readonly board: string; readonly thread: string }
  | { readonly kind: 'floor'; readonly board: string; readonly post: string };

const positiveId = (raw: string | null | undefined): string | undefined =>
  raw !== null && raw !== undefined && /^\d{1,10}$/.test(raw) && BigInt(raw) > 0n
    ? BigInt(raw).toString()
    : undefined;

const bahamutTargetError = (raw: string, resolutionRequired = false): FeedFailure =>
  new FeedError({
    code: 'FEED_INVALID_ACCOUNT',
    messageKey: resolutionRequired
      ? 'errors:feed.bahamut_resolution_required'
      : 'errors:feed.invalid_target',
    messageParams: {
      platform: FEED_PLATFORM_DISPLAY_NAMES.bahamut,
      account: raw.replace(/[`\r\n]/g, ' ').slice(0, 64),
    },
    context: { operation: 'BahamutPlatform.normalizeAccount' },
  });

export const canonicalBahamutTarget = (
  target: Exclude<BahamutTarget, { kind: 'floor' }>,
): string =>
  target.kind === 'thread'
    ? `${target.board}/${target.thread}`
    : `board:${target.board}${target.subboard === undefined ? '' : `:${target.subboard}`}`;

/** Local parsing never follows a user-supplied URL or accepts an arbitrary host. */
export const parseBahamutTarget = (raw: string): Result<BahamutTarget, FeedFailure> => {
  const input = raw.trim();
  const threadKey = /^(?:thread:)?(\d{1,10})[/:](\d{1,10})$/.exec(input);
  const boardKey = /^(?:board:)?(\d{1,10})(?::(\d{1,10}))?$/.exec(input);
  if (threadKey !== null) {
    const board = positiveId(threadKey[1]);
    const thread = positiveId(threadKey[2]);
    if (board !== undefined && thread !== undefined) return ok({ kind: 'thread', board, thread });
  }
  if (boardKey !== null) {
    const board = positiveId(boardKey[1]);
    const subboard = boardKey[2] === undefined ? undefined : positiveId(boardKey[2]);
    if (board !== undefined && (boardKey[2] === undefined || subboard !== undefined)) {
      return ok({ kind: 'board', board, ...(subboard === undefined ? {} : { subboard }) });
    }
  }
  try {
    const url = new URL(input);
    const desktop = url.hostname === 'forum.gamer.com.tw';
    const mobile = url.hostname === 'm.gamer.com.tw';
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      (!desktop && !mobile)
    )
      return err(bahamutTargetError(raw));
    const page = desktop ? url.pathname : url.pathname.replace(/^\/forum\//, '/');
    if (mobile && !url.pathname.startsWith('/forum/')) return err(bahamutTargetError(raw));
    for (const key of ['bsn', 'snA', 'sn', 'snB', 'subbsn']) {
      if (url.searchParams.getAll(key).length > 1) return err(bahamutTargetError(raw));
    }
    const board = positiveId(url.searchParams.get('bsn'));
    if (board === undefined) return err(bahamutTargetError(raw));
    if (page === '/B.php') {
      const sub = url.searchParams.get('subbsn');
      const subboard = sub === null || sub === '0' ? undefined : positiveId(sub);
      if (sub !== null && sub !== '0' && subboard === undefined)
        return err(bahamutTargetError(raw));
      return ok({ kind: 'board', board, ...(subboard === undefined ? {} : { subboard }) });
    }
    if (page === '/C.php') {
      const thread = positiveId(url.searchParams.get('snA'));
      if (thread !== undefined) return ok({ kind: 'thread', board, thread });
    }
    if (page === '/Co.php') {
      const post = positiveId(url.searchParams.get(mobile ? 'snB' : 'sn'));
      if (post !== undefined) return ok({ kind: 'floor', board, post });
    }
  } catch {
    // Invalid URLs are reported with the same target error as malformed IDs.
  }
  return err(bahamutTargetError(raw));
};

/** Canonical targets stay removable when the platform is disabled or unavailable. */
export const normalizeBahamutTargetOffline = (raw: string): Result<string, FeedFailure> => {
  const parsed = parseBahamutTarget(raw);
  if (!parsed.ok) return parsed;
  return parsed.value.kind === 'floor'
    ? err(bahamutTargetError(raw, true))
    : ok(canonicalBahamutTarget(parsed.value));
};
