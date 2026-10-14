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
  ChatInputCommandInteraction,
  Guild,
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
   * `respond` calls — the only answer an autocomplete interaction has.
   * One entry per call, each the full choice list that was offered.
   */
  readonly responses: Array<readonly ApplicationCommandOptionChoiceData[]>;
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

interface BuildChatInputInteractionInput {
  readonly commandName?: string;
  readonly userId?: string;
  readonly guildId?: string | null;
  readonly options?: Readonly<Record<string, string | number | boolean | null>>;
  /** Values `options.getChannel(name)` resolves, keyed by option name. */
  readonly channels?: Readonly<Record<string, ResolvedChannelOption>>;
  /** The invoking channel; also backs `interaction.channelId`. */
  readonly channel?: ResolvedChannelOption | null;
  /** Overrides the default `buildGuild({ id: guildId })`. */
  readonly guild?: Guild;
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
  responses: [],
  acknowledged: { deferred: false, replied: false },
});

export const buildChatInputInteraction = (
  input: BuildChatInputInteractionInput = {},
): ChatInputCommandInteraction => {
  const sink = input.sink ?? newSink();
  const options = input.options ?? {};
  const channels = input.channels ?? {};
  // A guild passed explicitly is authoritative for both fields, so
  // `interaction.guild.id` and `interaction.guildId` cannot disagree.
  const guild =
    input.guild ?? (input.guildId === null ? null : buildGuild({ id: input.guildId ?? 'g-1' }));
  return {
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    commandName: input.commandName ?? 'noop',
    user: { id: input.userId ?? 'u-1', displayName: 'tester' },
    guild,
    guildId: guild?.id ?? null,
    channel: input.channel ?? null,
    channelId: input.channel?.id ?? 'c-1',
    locale: 'zh-TW',
    // Discord stamps every interaction; `/feed subscribe` measures its
    // batch budget from this, so a fixture without it would silently
    // disable the deadline instead of exercising it.
    createdTimestamp: input.createdTimestamp ?? Date.now(),
    // Live acknowledgement state, so a handler's error boundary picks
    // `editReply` over `reply` exactly as it would at runtime — and so
    // a double-reply bug shows up here instead of only in production.
    get deferred(): boolean {
      return sink.acknowledged.deferred;
    },
    get replied(): boolean {
      return sink.acknowledged.replied;
    },
    options: {
      get: (name: string) =>
        Object.prototype.hasOwnProperty.call(options, name) ? { value: options[name] } : null,
      getString: (name: string) => (options[name] as string | undefined) ?? null,
      getInteger: (name: string) => (options[name] as number | undefined) ?? null,
      getChannel: (name: string) => channels[name] ?? null,
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
  } as unknown as ChatInputCommandInteraction;
};

interface BuildButtonInteractionInput {
  /** `<handler>|<payload>`; the leading segment selects the handler. */
  readonly customId: string;
  /** Who pressed the button — not necessarily who created it. */
  readonly userId?: string;
  readonly guildId?: string | null;
  /** Overrides the default `buildGuild({ id: guildId })`. */
  readonly guild?: Guild;
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
  return {
    isButton: () => true,
    isChatInputCommand: () => false,
    customId: input.customId,
    user: { id: input.userId ?? 'u-1', displayName: 'tester' },
    guild,
    guildId: guild?.id ?? null,
    locale: 'zh-TW',
    get deferred(): boolean {
      return sink.acknowledged.deferred;
    },
    get replied(): boolean {
      return sink.acknowledged.replied;
    },
    deferUpdate: async () => {
      sink.deferUpdates.push({});
      sink.acknowledged.deferred = true;
    },
    update: async (opts: SentMessage) => {
      if (input.updateError !== undefined) throw input.updateError;
      sink.updates.push(opts);
      sink.acknowledged.replied = true;
    },
    reply: async (opts: SentMessage) => {
      sink.replies.push(opts);
      sink.acknowledged.replied = true;
    },
    editReply: async (opts: SentMessage) => {
      sink.editReplies.push(opts);
    },
  } as unknown as ButtonInteraction;
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
    },
    respond: async (choices: readonly ApplicationCommandOptionChoiceData[]) => {
      if (input.respondError !== undefined) throw input.respondError;
      sink.responses.push(choices);
    },
  } as unknown as AutocompleteInteraction;
};

export const newInteractionSink = newSink;
