import { randomBytes } from 'node:crypto';
import {
  cloneSettings,
  GuildSettingsError,
  type GuildSettings,
  type GuildSettingsActor,
  type GuildSettingsSnapshot,
} from '../../core/guild-settings';

export interface GuildSettingsSession {
  readonly id: string;
  readonly botId: string;
  readonly guildId: string;
  readonly userId: string;
  messageId?: string;
  readonly expiresAt: number;
  baseRevision: number;
  base: GuildSettings;
  draft: GuildSettings;
  pending: boolean;
  saving: boolean;
  operationId?: string;
  modalNonce?: string;
  modalContext?: string;
  pendingSettings?: GuildSettings;
  pendingActor?: GuildSettingsActor;
  cancellationOperationId?: string;
}
export class GuildSettingsSessions {
  private readonly sessions = new Map<string, GuildSettingsSession>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maximum = 1000,
  ) {}
  open(actor: GuildSettingsActor, snapshot: GuildSettingsSnapshot): GuildSettingsSession {
    this.prune();
    for (const [id, session] of this.sessions) {
      if (
        session.botId === actor.botId &&
        session.guildId === actor.guildId &&
        session.userId === actor.userId
      )
        this.sessions.delete(id);
    }
    if (this.sessions.size >= this.maximum)
      throw new GuildSettingsError('unavailable', 'Session capacity reached');
    const session: GuildSettingsSession = {
      id: randomBytes(18).toString('base64url'),
      botId: actor.botId,
      guildId: actor.guildId,
      userId: actor.userId,
      expiresAt: this.now() + 600000,
      baseRevision: snapshot.revision,
      base: cloneSettings(snapshot.settings),
      draft: cloneSettings(snapshot.settings),
      pending: false,
      saving: false,
      ...(actor.messageId === undefined ? {} : { messageId: actor.messageId }),
    };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id: string, actor: GuildSettingsActor): GuildSettingsSession {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) throw new GuildSettingsError('expired');
    if (
      session.botId !== actor.botId ||
      session.guildId !== actor.guildId ||
      session.userId !== actor.userId ||
      session.messageId !== actor.messageId
    )
      throw new GuildSettingsError('forbidden');
    return session;
  }
  forgetGuild(guildId: string): void {
    for (const [id, session] of this.sessions)
      if (session.guildId === guildId) this.sessions.delete(id);
  }
  close(id: string): void {
    this.sessions.delete(id);
  }
  private prune(): void {
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }
}
