/**
 * Minimal interaction builders. Captures every reply via the `sink` so
 * assertions can read deferReply / reply / editReply / update /
 * followUp in order — including the flags each was sent with, which is
 * the only way a test can see that a reply stayed ephemeral.
 */
import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
  ButtonInteraction,
  Channel,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  Message,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';

import { buildGuild } from './guild-builder';

/**
 * What a send path records. `flags` carries `MessageFlags.Ephemeral`;
 * `components` is left opaque because a test asserts on the customIds
 * and styles a builder produced, not on the builder's own type.
 */
interface SentMessage {
  readonly content?: string;
  readonly flags?: number;
  readonly components?: readonly unknown[];
  readonly embeds?: readonly unknown[];
  readonly allowedMentions?: unknown;
}

interface InteractionMockSink {
  /** `deferReply` calls, with the flags the handler deferred under. */
  readonly defers: Array<{ flags?: number }>;
  /** `deferUpdate` calls — a component handler's acknowledgement. */
  readonly deferUpdates: Array<Record<string, never>>;
  readonly replies: SentMessage[];
  readonly editReplies: SentMessage[];
  /** `update` calls — a component handler editing the message it came from. */
  readonly updates: SentMessage[];
  /** Follow-ups in order — the overflow pages of a paginated reply. */
  readonly followUps: SentMessage[];
  /**
   * `deleteReply` calls, each the message it targeted; `@original` when
   * the handler named none. Removing the acknowledgement leaves no other
   * trace, so the call itself is the observable.
   */
  readonly deletes: string[];
  /**
   * `respond` calls — the only answer an autocomplete interaction has.
   * One entry per call, each the full choice list that was offered.
   */
  readonly responses: Array<readonly ApplicationCommandOptionChoiceData[]>;
  /**
   * `showModal` calls, each the modal builder as shown. Opaque for the
   * same reason as `components`: a test reads the builder's JSON.
   */
  readonly modals: unknown[];
  /** Acknowledgement state, mirroring what discord.js tracks. */
  readonly acknowledged: { deferred: boolean; replied: boolean };
}

/**
 * The structural minimum a resolved channel option needs. Handlers read
 * the id and resolve the real channel from the guild cache, so a
 * builder returning a full channel would invite assertions on fields
 * the handler never touches.
 */
interface ResolvedChannelOption {
  readonly id: string;
}

/**
 * The invoking channel: an id, plus whichever channel methods the
 * handler calls on it. Declared structurally rather than as `Channel`
 * so a literal with `isThread: () => true` does not have to satisfy
 * discord.js's type predicates.
 */
interface InvokingChannel extends ResolvedChannelOption {
  readonly isSendable?: () => boolean;
  readonly isThread?: () => boolean;
  readonly send?: (...args: never[]) => unknown;
  readonly fetch?: (...args: never[]) => unknown;
}

/** The structural minimum a resolved user option needs. */
interface ResolvedUserOption {
  readonly id: string;
  readonly displayName?: string;
  readonly username?: string;
}

/**
 * `interaction.memberPermissions` answering from a flag list; `null`
 * outside a guild, as discord.js reports it.
 */
const memberPermissionsFrom = (
  flags: readonly bigint[] | undefined,
): { has: (flag: bigint) => boolean } | null =>
  flags === undefined ? null : { has: (flag) => flags.includes(flag) };

/**
 * `options.getSubcommand` / `getSubcommandGroup` for a routed command.
 * Like discord.js, the subcommand is required unless the caller passes
 * `false` and the group is optional unless it passes `true`, so a
 * handler routing on a missing name throws here as it would at runtime.
 */
const subcommandRoute = (name: string | null | undefined, group: string | null | undefined) => ({
  getSubcommand: (required = true): string | null => {
    if (name === undefined || name === null) {
      if (required) throw new TypeError('No subcommand specified for interaction.');
      return null;
    }
    return name;
  },
  getSubcommandGroup: (required = false): string | null => {
    if (group === undefined || group === null) {
      if (required) throw new TypeError('No subcommand group specified for interaction.');
      return null;
    }
    return group;
  },
});

interface BuildChatInputInteractionInput {
  readonly commandName?: string;
  readonly userId?: string;
  /** The invoker's `user.username`, for handlers that sign output with it. */
  readonly username?: string;
  readonly guildId?: string | null;
  readonly options?: Readonly<Record<string, string | number | boolean | null>>;
  /** Values `options.getChannel(name)` resolves, keyed by option name. */
  readonly channels?: Readonly<Record<string, ResolvedChannelOption>>;
  /** Values `options.getUser(name)` resolves, keyed by option name. */
  readonly users?: Readonly<Record<string, ResolvedUserOption>>;
  /** The invoking channel; also backs `interaction.channelId`. */
  readonly channel?: InvokingChannel | null;
  /** Overrides the default `buildGuild({ id: guildId })`. */
  readonly guild?: Guild;
  /** The invoker's guild profile; `null` outside a guild, as discord.js reports it. */
  readonly member?: GuildMember | null;
  /** Flags the invoker holds in the channel; omitted means `memberPermissions` is `null`. */
  readonly memberPermissions?: readonly bigint[];
  /** The routed subcommand `options.getSubcommand` reports; omitted means none. */
  readonly subcommand?: string | null;
  /** The routed subcommand group `options.getSubcommandGroup` reports; omitted means none. */
  readonly subcommandGroup?: string | null;
  /** When the interaction was created; defaults to now. */
  readonly createdTimestamp?: number;
  readonly sink?: InteractionMockSink;
}

const newSink = (): InteractionMockSink => ({
  defers: [],
  deferUpdates: [],
  replies: [],
  editReplies: [],
  updates: [],
  followUps: [],
  deletes: [],
  responses: [],
  modals: [],
  acknowledged: { deferred: false, replied: false },
});

export const buildChatInputInteraction = (
  input: BuildChatInputInteractionInput = {},
): ChatInputCommandInteraction => {
  const sink = input.sink ?? newSink();
  const options = input.options ?? {};
  const channels = input.channels ?? {};
  const users = input.users ?? {};
  // A guild passed explicitly is authoritative for both fields, so
  // `interaction.guild.id` and `interaction.guildId` cannot disagree.
  const guild =
    input.guild ?? (input.guildId === null ? null : buildGuild({ id: input.guildId ?? 'g-1' }));
  return withReplies(sink, {
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    commandName: input.commandName ?? 'noop',
    user: {
      id: input.userId ?? 'u-1',
      displayName: 'tester',
      username: input.username ?? 'tester',
    },
    guild,
    guildId: guild?.id ?? null,
    member: input.member ?? null,
    channel: input.channel ?? null,
    channelId: input.channel?.id ?? 'c-1',
    memberPermissions: memberPermissionsFrom(input.memberPermissions),
    locale: 'zh-TW',
    // Discord stamps every interaction; `/feed subscribe` measures its
    // batch budget from this, so a fixture without it would silently
    // disable the deadline instead of exercising it.
    createdTimestamp: input.createdTimestamp ?? Date.now(),
    options: {
      get: (name: string) =>
        Object.prototype.hasOwnProperty.call(options, name) ? { value: options[name] } : null,
      getString: (name: string) => (options[name] as string | undefined) ?? null,
      getInteger: (name: string) => (options[name] as number | undefined) ?? null,
      getBoolean: (name: string) => (options[name] as boolean | undefined) ?? null,
      getChannel: (name: string) => channels[name] ?? null,
      // discord.js throws for a missing required option rather than
      // returning null, so a handler relying on `required` sees the same.
      getUser: (name: string, required?: boolean) => {
        const user = users[name];
        if (user === undefined && required === true) {
          throw new TypeError(`Required option "${name}" not found`);
        }
        return user ?? null;
      },
      ...subcommandRoute(input.subcommand, input.subcommandGroup),
    },
    // Showing a modal is the acknowledgement; a later reply would fail.
    showModal: async (modal: unknown) => {
      sink.modals.push(modal);
      sink.acknowledged.replied = true;
    },
  }) as unknown as ChatInputCommandInteraction;
};

interface BuildButtonInteractionInput {
  /** `<handler>|<payload>`; the leading segment selects the handler. */
  readonly customId: string;
  /** Who pressed the button — not necessarily who created it. */
  readonly userId?: string;
  readonly guildId?: string | null;
  /** Overrides the default `buildGuild({ id: guildId })`. */
  readonly guild?: Guild;
  /** The message the button is attached to. */
  readonly message?: Message;
  /** The channel the button was pressed in; also backs `channelId`. */
  readonly channel?: InvokingChannel | null;
  /** The presser's guild profile; `null` outside a guild. */
  readonly member?: GuildMember | null;
  /** Flags the presser holds in the channel; omitted means `memberPermissions` is `null`. */
  readonly memberPermissions?: readonly bigint[];
  readonly sink?: InteractionMockSink;
  /** When set, `update` rejects with it, so a handler's error path can be driven. */
  readonly updateError?: Error;
}

/**
 * Minimal ButtonInteraction builder, sharing the sink shape with the
 * chat-input one so a suite reads both the same way.
 *
 * `deferUpdate` and `update` both mark the interaction acknowledged, as
 * discord.js does, so a handler that edits after deferring picks
 * `editReply` here exactly as it would at runtime.
 */
export const buildButtonInteraction = (input: BuildButtonInteractionInput): ButtonInteraction => {
  const sink = input.sink ?? newSink();
  const guild =
    input.guild ?? (input.guildId === null ? null : buildGuild({ id: input.guildId ?? 'g-1' }));
  return withReplies(sink, {
    isButton: () => true,
    isChatInputCommand: () => false,
    customId: input.customId,
    user: { id: input.userId ?? 'u-1', displayName: 'tester' },
    guild,
    guildId: guild?.id ?? null,
    member: input.member ?? null,
    message: input.message,
    channel: input.channel ?? null,
    channelId: input.channel?.id ?? 'c-1',
    memberPermissions: memberPermissionsFrom(input.memberPermissions),
    locale: 'zh-TW',
    deferUpdate: async () => {
      sink.deferUpdates.push({});
      sink.acknowledged.deferred = true;
    },
    update: async (opts: SentMessage) => {
      if (input.updateError !== undefined) throw input.updateError;
      sink.updates.push(opts);
      sink.acknowledged.replied = true;
    },
  }) as unknown as ButtonInteraction;
};

interface BuildAutocompleteInteractionInput {
  readonly commandName?: string;
  readonly userId?: string;
  readonly guildId?: string | null;
  /** Overrides the default `buildGuild({ id: guildId })`. */
  readonly guild?: Guild;
  /**
   * Raw option values as typed so far. A channel option carries its id
   * here: Discord resolves entities only once the command is submitted,
   * so `options.getChannel` does not exist on this interaction.
   */
  readonly options?: Readonly<Record<string, string | number | boolean | null>>;
  /** The invoking channel; also backs `interaction.channelId`. */
  readonly channel?: ResolvedChannelOption | null;
  /** The routed subcommand `options.getSubcommand` reports; omitted means none. */
  readonly subcommand?: string | null;
  /** The routed subcommand group `options.getSubcommandGroup` reports; omitted means none. */
  readonly subcommandGroup?: string | null;
  /** The name of the option being typed into; `getFocused(true)` reports it. */
  readonly focusedOption?: string;
  /** What has been typed into that option so far. */
  readonly focused?: string;
  /** When set, `respond` rejects with it — the three-second window closing. */
  readonly respondError?: Error;
  readonly sink?: InteractionMockSink;
}

/**
 * Minimal AutocompleteInteraction builder.
 *
 * Shares the sink with the other builders, recording `respond` rather
 * than a reply: an autocomplete interaction cannot be replied to at
 * all, and a test that saw a reply here would be testing a bug.
 */
export const buildAutocompleteInteraction = (
  input: BuildAutocompleteInteractionInput = {},
): AutocompleteInteraction => {
  const sink = input.sink ?? newSink();
  const options = input.options ?? {};
  const guild =
    input.guild ?? (input.guildId === null ? null : buildGuild({ id: input.guildId ?? 'g-1' }));
  return {
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isRepliable: () => false,
    commandName: input.commandName ?? 'noop',
    user: { id: input.userId ?? 'u-1', displayName: 'tester' },
    guild,
    guildId: guild?.id ?? null,
    channelId: input.channel?.id ?? 'c-1',
    locale: 'zh-TW',
    options: {
      get: (name: string) =>
        Object.prototype.hasOwnProperty.call(options, name) ? { value: options[name] } : null,
      // Both overloads, because a hook that only reads the value cannot
      // tell which option Discord is asking about.
      getFocused: (full?: boolean) =>
        full === true
          ? { name: input.focusedOption ?? '', value: input.focused ?? '', focused: true }
          : (input.focused ?? ''),
      ...subcommandRoute(input.subcommand, input.subcommandGroup),
    },
    respond: async (choices: readonly ApplicationCommandOptionChoiceData[]) => {
      if (input.respondError !== undefined) throw input.respondError;
      sink.responses.push(choices);
    },
  } as unknown as AutocompleteInteraction;
};

/** The sink-recording reply surface, with live acknowledgement getters. */
const replySurface = (sink: InteractionMockSink) => ({
  get deferred(): boolean {
    return sink.acknowledged.deferred;
  },
  get replied(): boolean {
    return sink.acknowledged.replied;
  },
  deferReply: async (opts?: { flags?: number }) => {
    sink.defers.push(opts ?? {});
    sink.acknowledged.deferred = true;
  },
  reply: async (opts: SentMessage) => {
    sink.replies.push(opts);
    sink.acknowledged.replied = true;
  },
  editReply: async (opts: SentMessage) => {
    sink.editReplies.push(opts);
  },
  followUp: async (opts: SentMessage) => {
    sink.followUps.push(opts);
  },
  deleteReply: async (message?: string) => {
    sink.deletes.push(message ?? '@original');
  },
});

/**
 * Add the sink-recording reply surface — `deferReply` / `reply` /
 * `editReply` / `followUp` / `deleteReply` — to `fields`, so every
 * builder answers the reply methods the same way. Copied by
 * descriptor, because spreading would freeze the acknowledgement
 * getters at their build-time values.
 */
const withReplies = <T extends object>(sink: InteractionMockSink, fields: T): T =>
  Object.defineProperties(
    Object.assign(
      {
        isAutocomplete: () => false,
        isChatInputCommand: () => false,
        isContextMenuCommand: () => false,
        isModalSubmit: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isChannelSelectMenu: () => false,
        isRoleSelectMenu: () => false,
        isRepliable: () => true,
      },
      fields,
    ),
    Object.getOwnPropertyDescriptors(replySurface(sink)),
  );

/** discord.js throws when a modal field is absent; a fixture returning '' would hide that. */
const missingField = (id: string): never => {
  throw new TypeError(`Modal field "${id}" not found`);
};

interface BuildModalSubmitInteractionInput {
  /** `<handler>|<payload>`; the leading segment selects the handler. */
  readonly customId: string;
  readonly userId?: string;
  readonly guildId?: string | null;
  /** Overrides the default `buildGuild({ id: guildId })`. */
  readonly guild?: Guild;
  /** The channel the form was opened in; also backs `channelId`. */
  readonly channel?: Channel | null;
  /** Submitted text inputs, keyed by component custom ID. */
  readonly textInputs?: Readonly<Record<string, string>>;
  /** Submitted string-select values, keyed by component custom ID. */
  readonly selectValues?: Readonly<Record<string, readonly string[]>>;
  readonly sink?: InteractionMockSink;
}

/**
 * Minimal ModalSubmitInteraction builder. `fields` answers from
 * `textInputs` / `selectValues` and throws for an absent field, as
 * discord.js does.
 */
export const buildModalSubmitInteraction = (
  input: BuildModalSubmitInteractionInput,
): ModalSubmitInteraction => {
  const sink = input.sink ?? newSink();
  const textInputs = input.textInputs ?? {};
  const selectValues = input.selectValues ?? {};
  const guild =
    input.guild ?? (input.guildId === null ? null : buildGuild({ id: input.guildId ?? 'g-1' }));
  return withReplies(sink, {
    isModalSubmit: () => true,
    isChatInputCommand: () => false,
    isButton: () => false,
    customId: input.customId,
    user: { id: input.userId ?? 'u-1', displayName: 'tester' },
    guild,
    guildId: guild?.id ?? null,
    channel: input.channel ?? null,
    channelId: input.channel?.id ?? 'c-1',
    locale: 'zh-TW',
    fields: {
      getTextInputValue: (id: string) => textInputs[id] ?? missingField(id),
      getStringSelectValues: (id: string) => selectValues[id] ?? missingField(id),
    },
  }) as unknown as ModalSubmitInteraction;
};

interface BuildStringSelectInteractionInput {
  /** `<handler>|<payload>`; the leading segment selects the handler. */
  readonly customId: string;
  readonly values: readonly string[];
  readonly userId?: string;
  readonly guildId?: string | null;
  /** Overrides the default `buildGuild({ id: guildId })`. */
  readonly guild?: Guild;
  /** Flags the clicker holds; omitted means `memberPermissions` is `null`. */
  readonly memberPermissions?: readonly bigint[];
  /**
   * Messages `channel.messages.fetch(id)` resolves; any other id
   * rejects, as an unknown message does. Omitted means no channel.
   */
  readonly channelMessages?: Readonly<Record<string, Message>>;
  readonly sink?: InteractionMockSink;
}

/**
 * Minimal StringSelectMenuInteraction builder. `update` and
 * `deferUpdate` acknowledge, as on the button builder.
 */
export const buildStringSelectInteraction = (
  input: BuildStringSelectInteractionInput,
): StringSelectMenuInteraction => {
  const sink = input.sink ?? newSink();
  const guild =
    input.guild ?? (input.guildId === null ? null : buildGuild({ id: input.guildId ?? 'g-1' }));
  const messages = input.channelMessages;
  const channel =
    messages === undefined
      ? null
      : {
          id: 'c-1',
          messages: {
            fetch: async (id: string) => {
              const message = messages[id];
              if (message === undefined) throw new Error('Unknown Message');
              return message;
            },
          },
        };
  return withReplies(sink, {
    isStringSelectMenu: () => true,
    isChatInputCommand: () => false,
    isButton: () => false,
    customId: input.customId,
    values: input.values,
    user: { id: input.userId ?? 'u-1', displayName: 'tester' },
    guild,
    guildId: guild?.id ?? null,
    channel,
    channelId: channel?.id ?? null,
    memberPermissions: memberPermissionsFrom(input.memberPermissions),
    locale: 'zh-TW',
    client: {
      user: { username: 'Test Bot', displayAvatarURL: () => 'https://example.test/bot.png' },
    },
    deferUpdate: async () => {
      sink.deferUpdates.push({});
      sink.acknowledged.deferred = true;
    },
    update: async (opts: SentMessage) => {
      sink.updates.push(opts);
      sink.acknowledged.replied = true;
    },
  }) as unknown as StringSelectMenuInteraction;
};

/** A user as a context-menu target; `avatarUrl` backs `displayAvatarURL`. */
interface ContextMenuTargetUser {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string;
}

/** The target's guild profile; `avatarUrl` set means a server avatar. */
interface ContextMenuTargetMember {
  readonly displayName: string;
  readonly avatarUrl?: string;
}

interface BuildUserContextMenuInteractionInput {
  readonly commandName?: string;
  readonly targetUser: ContextMenuTargetUser;
  /**
   * What `guild.members.fetch(targetUser.id)` resolves; `null` makes it
   * reject, as for a user who is not a member.
   */
  readonly targetMember?: ContextMenuTargetMember | null;
  /** `null` invokes the menu outside a guild. */
  readonly guildId?: string | null;
  readonly sink?: InteractionMockSink;
}

/** discord.js appends the requested size to the CDN URL; mirroring it makes the size visible. */
const avatarUrlAt = (url: string, opts?: { size?: number }): string =>
  opts?.size === undefined ? url : `${url}?size=${String(opts.size)}`;

/**
 * Minimal UserContextMenuCommandInteraction builder. The guild's
 * `members.fetch` resolves the target's member profile, the only guild
 * read a user menu makes.
 */
export const buildUserContextMenuInteraction = (
  input: BuildUserContextMenuInteractionInput,
): UserContextMenuCommandInteraction => {
  const sink = input.sink ?? newSink();
  const target = input.targetUser;
  const member = input.targetMember ?? null;
  const fetchMember = async (id: string) => {
    if (member === null || id !== target.id) throw new Error('Unknown Member');
    return {
      id: target.id,
      displayName: member.displayName,
      // A member without a server avatar has a null hash, like discord.js.
      avatar: member.avatarUrl === undefined ? null : 'server-hash',
      displayAvatarURL: (opts?: { size?: number }) =>
        avatarUrlAt(member.avatarUrl ?? target.avatarUrl, opts),
    };
  };
  const guildId = input.guildId === undefined ? 'g-1' : input.guildId;
  const guild =
    guildId === null
      ? null
      : { id: guildId, members: { cache: new Map(), me: null, fetch: fetchMember } };
  return withReplies(sink, {
    isUserContextMenuCommand: () => true,
    isContextMenuCommand: () => true,
    isChatInputCommand: () => false,
    commandName: input.commandName ?? 'noop',
    user: { id: 'u-1', displayName: 'tester' },
    targetUser: {
      id: target.id,
      displayName: target.displayName,
      displayAvatarURL: (opts?: { size?: number }) => avatarUrlAt(target.avatarUrl, opts),
    },
    guild,
    guildId,
    locale: 'zh-TW',
  }) as unknown as UserContextMenuCommandInteraction;
};

export const newInteractionSink = newSink;
