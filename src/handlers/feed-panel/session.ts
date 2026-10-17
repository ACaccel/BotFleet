import { randomBytes } from 'node:crypto';
import type { FeedSubscriptionFilterInput } from '../../persistence/repositories';

const SESSION_LIFETIME_MS = 10 * 60 * 1000;

export interface FeedPanelActor {
  readonly applicationId: string;
  readonly guildId: string;
  readonly userId: string;
  readonly messageId?: string;
}

interface FeedPanelTarget {
  readonly id: string;
  readonly platform: string;
  readonly account: string;
  readonly channelId: string;
}

interface FeedFilterDraft {
  readonly kind: 'filter';
  readonly platformId: string;
  readonly accounts: readonly string[];
  readonly channelId: string;
  readonly subscriptionId?: string;
  filter: FeedSubscriptionFilterInput;
}

interface FeedListDraft {
  readonly kind: 'list';
  readonly targets: readonly FeedPanelTarget[];
  page: number;
}

export interface FeedPanelSession {
  readonly id: string;
  readonly actor: FeedPanelActor;
  readonly expiresAt: number;
  messageId?: string;
  draft: FeedFilterDraft | FeedListDraft;
  saving: boolean;
  modalNonce?: string;
}

export class FeedPanelError extends Error {
  public constructor(
    public readonly reason: 'expired' | 'forbidden' | 'busy' | 'invalid' | 'capacity',
  ) {
    super(`Feed panel ${reason}`);
  }
}

/** Ephemeral drafts never write subscriptions before explicit save. */
export class FeedPanelSessions {
  private readonly entries = new Map<string, FeedPanelSession>();

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly maximum = 1000,
  ) {}

  public open(actor: FeedPanelActor, draft: FeedPanelSession['draft']): FeedPanelSession {
    this.prune();
    if (this.entries.size >= this.maximum) throw new FeedPanelError('capacity');
    const session: FeedPanelSession = {
      id: randomBytes(16).toString('base64url'),
      actor: { ...actor },
      expiresAt: this.now() + SESSION_LIFETIME_MS,
      draft,
      saving: false,
    };
    this.entries.set(session.id, session);
    return session;
  }

  public get(id: string, actor: FeedPanelActor): FeedPanelSession {
    this.prune();
    const session = this.entries.get(id);
    if (!session) throw new FeedPanelError('expired');
    if (
      session.actor.applicationId !== actor.applicationId ||
      session.actor.guildId !== actor.guildId ||
      session.actor.userId !== actor.userId ||
      session.messageId === undefined ||
      session.messageId !== actor.messageId
    )
      throw new FeedPanelError('forbidden');
    if (session.saving) throw new FeedPanelError('busy');
    return session;
  }

  public close(id: string): void {
    this.entries.delete(id);
  }

  private prune(): void {
    for (const [id, session] of this.entries) {
      if (!session.saving && session.expiresAt <= this.now()) this.entries.delete(id);
    }
  }
}

const stores = new WeakMap<object, FeedPanelSessions>();

export const feedPanelSessions = (host: object): FeedPanelSessions => {
  let sessions = stores.get(host);
  if (!sessions) {
    sessions = new FeedPanelSessions();
    stores.set(host, sessions);
  }
  return sessions;
};

export const feedPanelId = (sessionId: string, action: string, detail = ''): string =>
  `feed_panel|${sessionId}|${action}|${detail}`;

export const parseFeedPanelId = (
  raw: string,
): { sessionId: string; action: string; detail: string } | undefined => {
  if (raw.length > 100) return undefined;
  const parts = raw.split('|');
  const [prefix, sessionId, action, detail] = parts;
  if (
    parts.length !== 4 ||
    prefix !== 'feed_panel' ||
    !sessionId ||
    !/^[\w-]+$/.test(sessionId) ||
    !action ||
    !/^[\w-]+$/.test(action) ||
    detail === undefined ||
    !/^[\w-]*$/.test(detail)
  )
    return undefined;
  return { sessionId, action, detail };
};
