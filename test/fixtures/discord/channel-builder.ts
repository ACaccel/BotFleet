/**
 * Minimal guild-channel builder for handler / plugin tests. Returns the
 * structural subset the `/traffic` visibility filter touches — `id`,
 * `name`, `type`, `parentId`, `parent`, and a `permissionsFor(subject)`
 * stub whose `ViewChannel` answer is driven by `viewableBy*`.
 *
 * The `@everyone` role and members are identified by id, so the stub
 * grants ViewChannel when the subject's id is in `viewableBy` (or when
 * `viewableByAll` is set, the default for an ordinary public channel).
 */
import { vi, type Mock } from 'vitest';
import {
  ChannelType,
  type Channel,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
} from 'discord.js';

/**
 * A channel a plugin can post to, plus handles on what it posted.
 *
 * Separate from {@link buildTextChannel}, whose shape is tuned to the
 * `/traffic` visibility filter: what a posting path needs is
 * `isSendable()` and a `send()` that resolves to a deletable message.
 */
interface SendableChannelFake {
  readonly channel: Channel;
  readonly send: Mock;
  /** The message `send` resolves with; its `delete` is a spy. */
  readonly message: { readonly id: string; readonly delete: Mock };
}

interface BuildSendableChannelInput {
  readonly id?: string;
  /** When false, `isSendable()` returns false and `send` is never reached. */
  readonly sendable?: boolean;
  readonly messageId?: string;
}

export const buildSendableChannel = (
  input: BuildSendableChannelInput = {},
): SendableChannelFake => {
  const message = {
    id: input.messageId ?? 'msg-1',
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const send = vi.fn().mockResolvedValue(message);
  return {
    message,
    send,
    channel: {
      id: input.id ?? 'chan-1',
      isSendable: () => input.sendable ?? true,
      send,
    } as unknown as Channel,
  };
};

/**
 * Channel types `isTextBased()` answers `true` for. Mirrors discord.js's
 * own set so a fixture cannot claim a category or forum is postable.
 */
const THREAD_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const TEXT_CAPABLE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

interface BuildChannelInput {
  readonly id: string;
  readonly name?: string;
  readonly type?: ChannelType;
  readonly parentId?: string | null;
  /** Parent channel used for a thread's ViewChannel inheritance. */
  readonly parent?: GuildBasedChannel | null;
  /** Subject ids (member or role id) granted ViewChannel. */
  readonly viewableBy?: ReadonlySet<string>;
  /** When true every subject may view; default for a simple public channel. */
  readonly viewableByAll?: boolean;
  /** When true `permissionsFor` returns null (permissions uncomputable). */
  readonly permissionsNull?: boolean;
  /**
   * Exact permission bits per subject id, for paths that ask about more
   * than ViewChannel. Takes precedence over `viewableBy*`; a subject
   * absent from the record holds no permission at all.
   */
  readonly permissionsBySubject?: Readonly<Record<string, readonly bigint[]>>;
}

export const buildTextChannel = (input: BuildChannelInput): GuildBasedChannel => {
  const viewableByAll = input.viewableByAll ?? true;
  const type = input.type ?? ChannelType.GuildText;
  // discord.js accepts a bare id wherever it accepts a member or role,
  // and handlers use that to avoid the `APIInteractionGuildMember` union.
  const permissionsFor = (
    subject: GuildMember | Role | string,
  ): { has: (flag: bigint) => boolean } | null => {
    if (input.permissionsNull === true) return null;
    const subjectId = typeof subject === 'string' ? subject : subject.id;
    if (input.permissionsBySubject !== undefined) {
      const bits = input.permissionsBySubject[subjectId] ?? [];
      return { has: (flag: bigint) => bits.includes(flag) };
    }
    const granted = viewableByAll || (input.viewableBy?.has(subjectId) ?? false);
    return { has: () => granted };
  };
  return {
    id: input.id,
    name: input.name ?? `channel-${input.id}`,
    type,
    parentId: input.parentId ?? null,
    parent: input.parent ?? null,
    isTextBased: () => TEXT_CAPABLE_CHANNEL_TYPES.has(type),
    // The predicate the feed poller actually demands of a destination;
    // a category or forum answers false for both.
    isSendable: () => TEXT_CAPABLE_CHANNEL_TYPES.has(type),
    isThread: () => THREAD_CHANNEL_TYPES.has(type),
    permissionsFor,
  } as unknown as GuildBasedChannel;
};
