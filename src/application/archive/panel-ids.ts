import { ARCHIVE_JOB_ID_PATTERN } from '../../core/archive/limits';

/**
 * Button custom IDs of the `/archive` panels: `archive|<action>|<argument>[|<page>]`.
 * Both the worker (which renders the full-backup panel) and the button handler use
 * them, so they live beside the panel renderer.
 */
export type ArchivePanelAction =
  | { readonly kind: 'start' | 'abort'; readonly token: string }
  | { readonly kind: 'stop' | 'resume' | 'restart' | 'progress'; readonly jobId: string }
  | { readonly kind: 'gaps'; readonly origin: ArchivePanelOrigin; readonly page: number }
  | { readonly kind: 'status' | 'records' };
/** Where a gap page returns to: the status panel or a full-backup panel. */
export type ArchivePanelOrigin =
  | { readonly kind: 'status' }
  | { readonly kind: 'job'; readonly jobId: string };

const TOKEN = /^[A-Za-z0-9_-]{24}$/;
const JOB = ARCHIVE_JOB_ID_PATTERN;
const PAGE = /^[1-9]\d{0,5}$/;

const origin = (value: ArchivePanelOrigin): string =>
  value.kind === 'status' ? 'status' : value.jobId;

export const archivePanelId = (action: ArchivePanelAction): string => {
  switch (action.kind) {
    case 'start':
    case 'abort':
      return `archive|${action.kind}|${action.token}`;
    case 'stop':
    case 'resume':
    case 'restart':
    case 'progress':
      return `archive|${action.kind}|${action.jobId}`;
    case 'gaps':
      return `archive|gaps|${origin(action.origin)}|${action.page}`;
    case 'status':
    case 'records':
      return `archive|${action.kind}`;
    default: {
      const unreachable: never = action;
      throw new TypeError(`Unknown archive panel action ${JSON.stringify(unreachable)}`);
    }
  }
};

/** `undefined` for an ID this version does not issue; the caller replies that it is stale. */
export const parseArchivePanelId = (customId: string): ArchivePanelAction | undefined => {
  const [prefix, kind, argument, extra, ...rest] = customId.split('|');
  if (prefix !== 'archive' || rest.length > 0) return undefined;
  switch (kind) {
    case 'start':
    case 'abort':
      return argument !== undefined && TOKEN.test(argument) && extra === undefined
        ? { kind, token: argument }
        : undefined;
    case 'stop':
    case 'resume':
    case 'restart':
    case 'progress':
      return argument !== undefined && JOB.test(argument) && extra === undefined
        ? { kind, jobId: argument }
        : undefined;
    case 'gaps': {
      if (argument === undefined || extra === undefined || !PAGE.test(extra)) return undefined;
      const page = Number(extra);
      if (page > 100_000) return undefined;
      if (argument === 'status') return { kind, origin: { kind: 'status' }, page };
      return JOB.test(argument)
        ? { kind, origin: { kind: 'job', jobId: argument }, page }
        : undefined;
    }
    case 'status':
    case 'records':
      return argument === undefined ? { kind } : undefined;
    default:
      return undefined;
  }
};
